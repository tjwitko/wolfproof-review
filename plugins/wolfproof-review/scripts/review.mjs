#!/usr/bin/env node
// wolfproof-review's command line, used by the GitHub workflow and the local /wolfproof-review command.
//
//   review.mjs sort     --result F --diff F --files F --out F [--root DIR] [--ignore GLOBS] [--meta F]
//   review.mjs prompt   --agent F --sorted F --diff F --code-dir D --rulebook F --max-comments N
//                       [--existing F] [--mode ci|local] (--out F | --github-output NAME)
//   review.mjs existing --out F                          (GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER)
//   review.mjs run      --provider P [--model M] [--base-url U] --prompt F --code-dir D --input-dir D
//                       --rulebook-dir D --diff F --max-comments N --head SHA --out F [--max-turns N] [--minutes N]
//                                                    (REVIEW_API_KEY, and the same variables as existing)
//   review.mjs check    --diff F --since ISO --out F     (the same variables)
//   review.mjs summary  --sorted F [--status STATUS] [--run F] [--check F] [--note TEXT] [--post]
//   review.mjs local    [base] [--no-scan]           (wolfproof: node_modules/wolfproof, else WOLFPROOF_BIN)
//
// Exit 0, or 2 on a usage error. A GitHub call that fails is reported and, for `summary --post`,
// does not fail the step: the job summary still carries the text.

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sortFindings, renderSummary, buildPrompt, offDiff, parseDiff, changedFromPatches, diffDisagreement, localDirName, STAMP, wolfproofCommand } from "./lib.mjs";
import { botReviewComments, postInlineComment, pullFiles, upsertSummary } from "./github.mjs";
import { makeTools, runReview, logSafe } from "./agent.mjs";
import { adapter } from "./providers.mjs";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LARGE_CHANGE = 1500;

function opts(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) o._.push(a);
    else if (a.includes("=")) o[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) o[a.slice(2)] = argv[++i];
    else o[a.slice(2)] = true;
  }
  return o;
}

function need(o, ...names) {
  const missing = names.filter((n) => o[n] === undefined || o[n] === true);
  if (missing.length) {
    console.error(`wolfproof-review: missing ${missing.map((n) => `--${n}`).join(", ")}`);
    process.exit(2);
  }
}

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const readText = (f) => (f && existsSync(f) ? readFileSync(f, "utf8") : "");
const lines = (s) => String(s).split("\n").map((l) => l.trim()).filter(Boolean);

function sort(o) {
  need(o, "diff", "files", "out");
  const sorted = sortFindings({
    result: o.result ? readJson(o.result) : null,
    diff: readText(o.diff),
    files: lines(readText(o.files)),
    root: o.root || "",
    ignore: typeof o.ignore === "string" ? lines(o.ignore.replace(/,/g, "\n")) : [],
    meta: o.meta ? readJson(o.meta) || {} : {},
  });
  writeFileSync(o.out, JSON.stringify(sorted, null, 2));
  const c = sorted.counts;
  console.log(`sorted: ${c["changed-line"]} on changed lines, ${c["changed-file"]} in changed files, ${c.elsewhere} elsewhere${c.ignored ? `, ${c.ignored} ignored` : ""}`);
}

function prompt(o) {
  need(o, "agent", "sorted", "diff", "code-dir", "rulebook", "max-comments");
  const sorted = readJson(o.sorted) || { change: { lines: 0 } };
  const text = buildPrompt(readFileSync(o.agent, "utf8"), {
    mode: o.mode === "local" ? "local" : "ci",
    codeDir: o["code-dir"],
    diffPath: o.diff,
    sortedPath: o.sorted,
    rulebookPath: o.rulebook,
    existingPath: o.existing || null,
    maxComments: Number(o["max-comments"]),
    changedLines: sorted.change?.lines || 0,
    largeChange: LARGE_CHANGE,
  });
  if (o.out) writeFileSync(o.out, text);
  if (o["github-output"]) {
    const delimiter = `EOF_${randomBytes(12).toString("hex")}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `${o["github-output"]}<<${delimiter}\n${text}\n${delimiter}\n`);
  }
}

async function existing(o) {
  need(o, "out");
  let list = [];
  try {
    list = (await botReviewComments()).map((c) => ({ path: c.path, line: c.line ?? c.original_line, body: String(c.body || "").slice(0, 400) }));
  } catch (err) {
    console.error(`wolfproof-review: could not list earlier comments (${err.message}); continuing without them`);
  }
  writeFileSync(o.out, JSON.stringify(list, null, 2));
  console.log(`${list.length} earlier inline comment(s)`);
}

// The model's review: plain API calls to the chosen provider, with only agent.mjs's four tools. The
// key is read here and goes nowhere but the provider's request headers.
async function review(o) {
  need(o, "provider", "prompt", "code-dir", "input-dir", "rulebook-dir", "diff", "max-comments", "head", "out");
  let out;
  try {
    const a = adapter({
      provider: o.provider,
      apiKey: process.env.REVIEW_API_KEY,
      model: typeof o.model === "string" ? o.model : undefined,
      baseUrl: typeof o["base-url"] === "string" ? o["base-url"] : undefined,
    });
    const dirs = [o["code-dir"], o["input-dir"], o["rulebook-dir"]];
    const tools = makeTools({
      cwd: process.cwd(),
      roots: dirs.map((d) => ({ name: d, dir: d })),
      codeRoot: o["code-dir"],
      changed: parseDiff(readText(o.diff)),
      maxComments: Number(o["max-comments"]),
      // The head commit from the workflow's event, not from the scan's files, which the pull request's
      // code could have written.
      post: (c) => postInlineComment({ ...c, commitId: o.head }),
    });
    out = await runReview({
      adapter: a,
      prompt: readText(o.prompt),
      tools,
      maxTurns: Number(o["max-turns"]) || 60,
      maxInputTokens: inputBudget(o["max-input-tokens"]),
      deadline: Date.now() + (Number(o.minutes) || 20) * 60 * 1000,
    });
  } catch (err) {
    out = { status: "failed", provider: o.provider, model: typeof o.model === "string" ? o.model : null, turns: 0, calls: [], usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, posted: 0, stopped: null, error: logSafe(err.message) };
  }
  writeFileSync(o.out, JSON.stringify(out, null, 2));
  const u = out.usage;
  console.log(
    `review: ${out.status} with ${out.provider} ${out.model || ""}, ${out.turns} turn(s), ${out.posted} comment(s), ` +
      `${u.input + u.cacheRead + u.cacheWrite} input tokens (${u.input} uncached, ${u.cacheRead} read from the cache, ${u.cacheWrite} written to it) and ${u.output} output tokens`
  );
  if (out.rejected && (out.rejected.offDiff || out.rejected.overLimit || out.rejected.badPath)) {
    console.log(`refused: ${out.rejected.offDiff} off the diff, ${out.rejected.overLimit} over the limit, ${out.rejected.badPath} outside the readable folders`);
  }
  if (out.error) {
    console.log(`::warning::wolfproof-review: the review did not finish: ${out.error}`);
    process.exitCode = 1;
  }
}

/** The run's input-token budget: the --max-input-tokens given, else the default. */
const DEFAULT_MAX_INPUT_TOKENS = 1000000;
function inputBudget(v) {
  if (v === undefined || v === true) return DEFAULT_MAX_INPUT_TOKENS;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`max-input-tokens is a whole number of at least 1, not "${String(v).slice(0, 40)}"`);
  return n;
}

// After the review: where did its comments land? Checked against GitHub's own diff of the pull request
// (its patches), not this job's diff, so a fault in the diff or its parser that let a comment through
// the comment tool shows up here instead of being passed again by the same code.
async function check(o) {
  need(o, "diff", "since", "out");
  const since = Date.parse(o.since);
  let result = { posted: 0, offDiff: [], unchecked: [], disagree: [], error: null };
  try {
    const mine = (await botReviewComments()).filter((c) => Date.parse(c.created_at) >= since);
    const { changed, unknown } = changedFromPatches(await pullFiles());
    const checkable = mine.filter((c) => !unknown.has(c.path));
    result = {
      posted: mine.length,
      offDiff: offDiff(checkable, changed),
      unchecked: mine.filter((c) => unknown.has(c.path)).map((c) => ({ path: c.path, line: c.line ?? c.original_line ?? null })),
      // Where this job's diff and GitHub's disagree, for the log: a parser fault, or a diff the
      // two computed differently.
      disagree: diffDisagreement(parseDiff(readText(o.diff)), changed, unknown),
      error: null,
    };
  } catch (err) {
    result.error = err.message;
  }
  writeFileSync(o.out, JSON.stringify(result, null, 2));
  console.log(`${result.posted} comment(s) this run, ${result.offDiff.length} off the diff${result.error ? ` (error: ${result.error})` : ""}`);
  for (const x of result.offDiff) console.log(`::warning::wolfproof-review commented off the diff at ${logSafe(x.path)}:${x.line}`);
  if (result.unchecked.length) console.log(`${result.unchecked.length} comment(s) on files GitHub shows no patch for, so not checked`);
  if (result.disagree.length) {
    console.log(`::notice::this job's diff and GitHub's disagree on ${result.disagree.length} file(s): ${result.disagree.slice(0, 10).map(logSafe).join(", ")}`);
  }
}

async function summary(o) {
  need(o, "sorted");
  const sorted = readJson(o.sorted) || { meta: {}, scan: { ran: false }, change: { files: 0, lines: 0 }, findings: [], counts: {} };
  const checked = o.check ? readJson(o.check) : null;
  const ran = o.run ? readJson(o.run) : null;
  const status = ran?.status || (typeof o.status === "string" ? o.status : "not-run");
  const shown = {
    status,
    model: ran?.model || undefined,
    posted: checked?.posted ?? ran?.posted,
    offDiff: checked?.offDiff,
    note: ran?.error || (typeof o.note === "string" ? o.note : undefined),
    stopped: ran?.stopped || undefined,
    maxInputTokens: ran?.maxInputTokens ?? undefined,
  };
  const body = renderSummary(sorted, { review: shown });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body.replace(/^<!--.*-->\n/, "") + "\n");
  else process.stdout.write(body + "\n");
  if (o.post) {
    try {
      await upsertSummary(body);
      console.log("summary comment posted");
    } catch (err) {
      // A fork's pull request has a read-only token: the job summary is all it gets.
      console.log(`::notice::wolfproof-review could not post the summary comment (${err.status || ""} ${err.message.split(":")[0]}); it is in the job summary`);
    }
  }
}

// ---- Local use, from the /wolfproof-review command --------------------------------------------

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// The working tree's diff against the merge base, with attributes from an empty tree as in CI, so a
// "-diff" or "binary" in .gitattributes still shows the lines. git before 2.40 has no --attr-source;
// there the diff runs without it, and says what that can hide.
function localDiff(cwd, mergeBase) {
  const args = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-U0", "-M", mergeBase];
  const noattr = git(["hash-object", "-t", "tree", "/dev/null"], cwd).trim();
  const r = spawnSync("git", [`--attr-source=${noattr}`, ...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status === 0) return r.stdout;
  if (/unknown option:? ['"]?--attr-source/i.test(r.stderr || "")) {
    console.log(
      "note: this git has no --attr-source (it came in git 2.40), so the diff follows .gitattributes: " +
        'a file marked "-diff" or "binary" shows no changed lines, and its findings are not on the change. Update git to review those lines.'
    );
    return git(args, cwd);
  }
  throw new Error(`git diff failed: ${String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 300)}`);
}

function defaultBase(cwd) {
  try {
    return git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd).trim();
  } catch {
    for (const b of ["main", "master", "origin/main", "origin/master"]) {
      try {
        git(["rev-parse", "--verify", "--quiet", b], cwd);
        return b;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function local(o) {
  const cwd = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const base = o._[1] || defaultBase(cwd);
  if (!base) {
    console.error("wolfproof-review: no base branch given and none found (tried origin/HEAD, main, master)");
    process.exit(2);
  }
  const mergeBase = git(["merge-base", base, "HEAD"], cwd).trim();
  // The pull-request hook (pr-hook.mjs) reads meta.json here to tell whether HEAD has been reviewed.
  const dir = path.join(os.tmpdir(), localDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);

  // The working tree against the merge base: committed and uncommitted changes to tracked files.
  writeFileSync(f("diff.patch"), localDiff(cwd, mergeBase));
  writeFileSync(f("files.txt"), git(["-c", "core.quotePath=false", "ls-files"], cwd));

  let resultFile = null;
  let scanNote = "";
  let scannedWith = "";
  // A relative WOLFPROOF_BIN is from the directory the review was started in, not the repository's top.
  const fsys = { exists: existsSync, isDir: (p) => statSync(p).isDirectory() };
  const gate = o["no-scan"] ? null : wolfproofCommand(cwd, process.env, fsys, process.execPath, process.cwd());
  if (!gate) scanNote = "Scan skipped (--no-scan).";
  else if (gate.note) scanNote = gate.note;
  else {
    // The gate runs the project's tests and builds, as it always does.
    scannedWith = gate.via;
    const r = spawnSync(gate.file, [...gate.args, ".", "--json"], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000 });
    if (r.stdout && r.stdout.trim().startsWith("{")) {
      writeFileSync(f("result.json"), r.stdout);
      resultFile = f("result.json");
    } else {
      const why = r.error?.code === "ENOENT" ? "it was not found" : `exit ${r.status}${r.error ? `, ${r.error.code}` : ""}`;
      scanNote = `wolfproof, from ${gate.via}, did not produce a result (${why}), so there are no scanner findings; the review uses the rulebook alone.`;
    }
  }
  const head = git(["rev-parse", "HEAD"], cwd).trim();
  writeFileSync(f("meta.json"), JSON.stringify({ head, base, mergeBase, scanNote, mode: "local" }));
  // What the pull-request hook (pr-hook.mjs) checks: which commit was reviewed, against which base.
  // In the repository's own git directory, which the hook finds whatever temporary directory it sees.
  try {
    writeFileSync(path.join(git(["rev-parse", "--absolute-git-dir"], cwd).trim(), STAMP), JSON.stringify({ head, base }) + "\n");
  } catch (err) {
    console.log(`note: could not record this review for the pull-request hook (${err.code || err.message}).`);
  }
  sort({ result: resultFile, diff: f("diff.patch"), files: f("files.txt"), root: cwd, out: f("sorted.json"), meta: f("meta.json") });
  prompt({
    agent: path.join(PLUGIN, "agents", "wolfproof-reviewer.md"),
    sorted: f("sorted.json"),
    diff: f("diff.patch"),
    "code-dir": cwd,
    rulebook: path.join(PLUGIN, "rulebook", "checks.md"),
    "max-comments": o["max-comments"] || 15,
    mode: "local",
    out: f("prompt.md"),
  });
  if (scannedWith) console.log(`wolfproof: ${scannedWith}`);
  if (scanNote) console.log(scanNote);
  console.log(`base: ${base} (merge base ${mergeBase.slice(0, 7)})`);
  console.log(`instructions: ${f("prompt.md")}`);
}

const o = opts(process.argv.slice(2));
const commands = { sort, prompt, existing, run: review, check, summary, local };
const run = commands[o._[0]];
if (!run) {
  console.error(`usage: review.mjs <${Object.keys(commands).join("|")}> ...`);
  process.exit(2);
}
await run(o);
