// The GitHub review's agent loop and its four tools. The model gets these and nothing else: read a
// file, search, list files, and comment on a line the change added or modified. There is no shell,
// no file writing and no network, so text in a pull request that tries to instruct the model has
// nothing to run. Every path is confined to the folders the review may read, after symlinks are
// resolved, because the pull request's own files can be symlinks to anywhere on the runner.

import { execFile } from "node:child_process";
import { lstatSync, openSync, readSync, closeSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { globToRegExp, onChangedLine } from "./lib.mjs";
import { send, ProviderError } from "./providers.mjs";

const READ_LINES = 2000;
const READ_BYTES = 256 * 1024;
const FILE_LIMIT = 16 * 1024 * 1024;
const GREP_LINES = 200;
const GREP_BYTES = 64 * 1024;
const GLOB_RESULTS = 1000;
const WALK_LIMIT = 50000;
const BODY_LIMIT = 60000;

export const TOOLS = [
  {
    name: "read_file",
    description:
      "Read a text file, with line numbers. `path` as the run's instructions give it, for example pr-head/app/views.py. Optional `offset` (first line, from 1) and `limit` (at most 2000 lines).",
    schema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents with an extended regular expression. Returns path:line:text, at most 200 lines. Optional `path` (a folder or file, default the code at the change's head), `glob` (file names to include, such as *.py) and `ignore_case`.",
    schema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, ignore_case: { type: "boolean" } },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description: "List files whose path matches a glob such as **/*.py, at most 1000. Optional `path`: the folder to search, default the code at the change's head.",
    schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
  },
  {
    name: "create_inline_comment",
    description:
      "Post one inline review comment. `path` relative to the repository root, `line` the line number in the change's version of the file, optional `start_line` for a range, and `body` in Markdown. Only lines the change added or modified are accepted.",
    schema: {
      type: "object",
      properties: { path: { type: "string" }, line: { type: "integer" }, start_line: { type: "integer" }, body: { type: "string" } },
      required: ["path", "line", "body"],
    },
  },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
// Stop reasons that mean the reply did not end normally: Anthropic's and OpenAI's.
const CUT_OFF = new Set(["max_tokens", "refusal", "model_context_window_exceeded", "length", "content_filter"]);

/** Why an input does not fit a tool's schema, or null. Only the shapes TOOLS uses. */
export function badInput(schema, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "the input is not an object";
  for (const r of schema.required || []) if (input[r] === undefined || input[r] === null) return `"${r}" is required`;
  for (const [k, v] of Object.entries(input)) {
    const want = schema.properties[k]?.type;
    if (!want) return `unknown field "${k}"`;
    if (v === null || v === undefined) continue;
    if (want === "integer" ? !Number.isInteger(v) : typeof v !== want) return `"${k}" must be ${want === "integer" ? "an integer" : `a ${want}`}`;
  }
  return null;
}

class ToolError extends Error {}

/**
 * The tools, bound to this run.
 * @param {object} o
 * @param {string} o.cwd the directory the instructions' relative paths start from
 * @param {Array<{name: string, dir: string}>} o.roots folders the model may read: name as shown, dir on disk
 * @param {string} o.codeRoot the name of the root that holds the change's code (paths in comments are relative to it)
 * @param {Map} o.changed parseDiff's result for the change
 * @param {number} o.maxComments
 * @param {(c: {path: string, line: number, start_line?: number, body: string}) => Promise<void>} o.post
 */
export function makeTools({ cwd, roots, codeRoot, changed, maxComments, post }) {
  const real = roots.map((r) => ({ name: r.name, real: realpathSync(path.resolve(cwd, r.dir)) }));
  const code = real.find((r) => r.name === codeRoot);
  const stats = { posted: 0, rejected: { offDiff: 0, overLimit: 0, badPath: 0 } };

  // A path the model gave, as a real path inside a root, and how to show it back.
  function resolve(p, { must = "any" } = {}) {
    if (typeof p !== "string" || !p.trim() || p.includes("\0")) throw new ToolError("give a path");
    let rp;
    try {
      rp = realpathSync(path.resolve(cwd, p));
    } catch {
      throw new ToolError(`${p}: no such file or folder`);
    }
    const root = real.find((r) => rp === r.real || rp.startsWith(r.real + path.sep));
    if (!root) {
      stats.rejected.badPath++;
      throw new ToolError(`${p}: outside the files this review may read (${real.map((r) => r.name).join(", ")})`);
    }
    const st = statSync(rp);
    if (must === "file" && !st.isFile()) throw new ToolError(`${p}: not a file`);
    const shown = rp === root.real ? root.name : path.join(root.name, path.relative(root.real, rp));
    return { rp, root, shown, isDir: st.isDirectory() };
  }

  // A real path back to the name the model knows it by.
  const show = (abs) => {
    const root = real.find((r) => abs === r.real || abs.startsWith(r.real + path.sep));
    return root ? path.join(root.name, path.relative(root.real, abs)) : null;
  };

  const tools = {
    read_file({ path: p, offset, limit }) {
      const { rp, shown } = resolve(p, { must: "file" });
      const size = statSync(rp).size;
      if (size > FILE_LIMIT) throw new ToolError(`${shown}: too large to read (${size} bytes)`);
      const buf = Buffer.alloc(size);
      const fd = openSync(rp, "r");
      try {
        readSync(fd, buf, 0, size, 0);
      } finally {
        closeSync(fd);
      }
      if (buf.subarray(0, 8192).includes(0)) throw new ToolError(`${shown}: a binary file`);
      const all = buf.toString("utf8").split("\n");
      const first = Math.max(1, offset || 1);
      const count = Math.min(READ_LINES, Math.max(1, limit || READ_LINES));
      let out = "";
      let n = first;
      for (; n < first + count && n <= all.length; n++) {
        const line = `${n}\t${all[n - 1]}\n`;
        if (out.length + line.length > READ_BYTES) break;
        out += line;
      }
      if (n <= all.length) out += `(${all.length - n + 1} more line(s); read on with offset ${n})\n`;
      return out || `${shown}: empty, or no lines from ${first}`;
    },

    grep({ pattern, path: p, glob, ignore_case }) {
      const target = p ? resolve(p) : { rp: code.real, shown: code.name };
      const args = ["-rnIH", "-E", "--color=never", "--exclude-dir=.git"];
      if (ignore_case) args.push("-i");
      if (glob) args.push(`--include=${glob}`);
      args.push("-e", pattern, "--", target.rp);
      return new Promise((done, fail) => {
        // No shell, and an environment without the API key or any token.
        execFile("grep", args, { env: { PATH: process.env.PATH || "/usr/bin:/bin", LC_ALL: "C" }, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err && err.code === 1) return done("no matches");
          const truncated = Boolean(err && (err.killed || err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"));
          if (err && !truncated) return fail(new ToolError(`grep failed: ${String(stderr || err.message).split("\n")[0].slice(0, 200)}`));
          const lines = [];
          let bytes = 0;
          for (const raw of String(stdout).split("\n")) {
            if (!raw) continue;
            const i = raw.indexOf(":");
            const shown = show(raw.slice(0, i));
            if (!shown) continue;
            const line = `${shown}${raw.slice(i)}`.slice(0, 500);
            if (lines.length >= GREP_LINES || bytes + line.length > GREP_BYTES) {
              lines.push(`(more matches; narrow the pattern or the path)`);
              break;
            }
            lines.push(line);
            bytes += line.length;
          }
          if (truncated) lines.push("(the search stopped early)");
          done(lines.join("\n") || "no matches");
        });
      });
    },

    glob({ pattern, path: p }) {
      const start = p ? resolve(p) : { rp: code.real, shown: code.name, isDir: true };
      if (!start.isDir) throw new ToolError(`${start.shown}: not a folder`);
      const re = globToRegExp(pattern);
      const out = [];
      let seen = 0;
      const walk = (dir, rel) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (++seen > WALK_LIMIT || out.length >= GLOB_RESULTS) return;
          if (e.isSymbolicLink() || e.name === ".git") continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(path.join(dir, e.name), r);
          else if (e.isFile() && re.test(r)) out.push(path.join(start.shown, r));
        }
      };
      walk(start.rp, "");
      if (out.length >= GLOB_RESULTS || seen > WALK_LIMIT) out.push("(more files; narrow the pattern or the path)");
      return out.join("\n") || "no files match";
    },

    async create_inline_comment({ path: p, line, start_line, body }) {
      // The path is the repository's, as in the diff. Accept the code folder's prefix too.
      const file = String(p).replace(/^\.\//, "").replace(new RegExp(`^${code.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`), "");
      const first = start_line ?? line;
      if (line < 1 || first < 1 || first > line) throw new ToolError("line and start_line must be line numbers, with start_line at or before line");
      for (let l = first; l <= line; l++) {
        if (!onChangedLine(changed, file, l)) {
          stats.rejected.offDiff++;
          throw new ToolError(`${file}:${l} is not a line this change added or modified, so it cannot carry a comment. Comment on a changed line instead.`);
        }
      }
      if (!body.trim()) throw new ToolError("the comment is empty");
      if (body.length > BODY_LIMIT) throw new ToolError(`the comment is longer than ${BODY_LIMIT} characters`);
      if (stats.posted >= maxComments) {
        stats.rejected.overLimit++;
        throw new ToolError(`the limit of ${maxComments} comments is reached; post no more`);
      }
      try {
        await post({ path: file, line, ...(start_line && start_line < line ? { start_line } : {}), body });
      } catch (err) {
        throw new ToolError(`GitHub did not take the comment (${err.status || ""} ${String(err.message).split(":")[0]})`);
      }
      stats.posted++;
      return `posted on ${file}:${line}`;
    },
  };

  return {
    stats,
    async run(name, input) {
      if (!NAMES.has(name)) return { content: `there is no tool "${String(name).slice(0, 60)}"`, isError: true };
      const bad = badInput(TOOLS.find((t) => t.name === name).schema, input);
      if (bad) return { content: `${name}: ${bad}`, isError: true };
      try {
        return { content: String(await tools[name](input)), isError: false };
      } catch (err) {
        if (err instanceof ToolError) return { content: err.message, isError: true };
        return { content: `${name} failed (${err.code || err.name})`, isError: true };
      }
    },
  };
}

/** A line for the workflow log: no line breaks, and never a workflow command (`::…`). */
export function logSafe(s) {
  return String(s).replace(/[\r\n\u0000-\u001f]+/g, " ").replace(/^:+/, "").slice(0, 500);
}

/**
 * Run the review: model turns and tool calls until the model stops calling tools.
 * The log gets only each call's tool name and whether it worked, never content.
 * @returns {Promise<object>} what run.json records
 */
export async function runReview({ adapter, prompt, tools, maxTurns = 60, deadline = Infinity, now = Date.now, log = console.log, sendOptions = {} }) {
  const out = { status: "failed", provider: adapter.provider, model: adapter.model, turns: 0, calls: [], usage: { input: 0, output: 0 }, error: null };
  const messages = adapter.initial(prompt);
  try {
    for (;;) {
      if (out.turns >= maxTurns) throw new ProviderError(`stopped at the turn limit (${maxTurns})`);
      if (now() > deadline) throw new ProviderError(`stopped at the time limit, after ${out.turns} turn(s)`);
      out.turns++;
      const res = await send(adapter, messages, TOOLS, sendOptions);
      out.usage.input += res.usage.input;
      out.usage.output += res.usage.output;
      // A reply that was cut off, or refused, is not a finished review, and a tool call in it may be
      // incomplete.
      if (CUT_OFF.has(res.stop)) throw new ProviderError(`the reply was cut off (${res.stop})`);
      messages.push(res.assistant);
      if (!res.toolCalls.length) {
        out.status = "ran";
        break;
      }
      const results = [];
      for (const call of res.toolCalls) {
        const r = call.inputError ? { content: `${call.name}: ${call.inputError}`, isError: true } : await tools.run(call.name, call.input);
        const name = NAMES.has(call.name) ? call.name : "(unknown tool)";
        out.calls.push({ name, ok: !r.isError });
        log(`turn ${out.turns}: ${name} ${r.isError ? "error" : "ok"}`);
        results.push({ id: call.id, ...r });
      }
      messages.push(...adapter.results(results));
    }
  } catch (err) {
    out.error = logSafe(err.message);
  }
  Object.assign(out, tools.stats);
  return out;
}
