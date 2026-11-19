import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeTools, runReview, badInput, logSafe, TOOLS } from "../plugins/wolfproof-review/scripts/agent.mjs";
import { adapter } from "../plugins/wolfproof-review/scripts/providers.mjs";
import { parseDiff } from "../plugins/wolfproof-review/scripts/lib.mjs";

const DIFF = [
  "diff --git a/app/views.py b/app/views.py",
  "--- a/app/views.py",
  "+++ b/app/views.py",
  "@@ -3,0 +4,2 @@",
  "+    term = request.args.get('q')",
  "+    db.execute('SELECT * FROM t WHERE x = ' + term)",
].join("\n");

// A workspace laid out as the review job's: the pull request in pr-head, the scan's files, the
// rulebook, and a file outside all of them that a hostile pull request would like to read.
function workspace() {
  const top = mkdtempSync(path.join(os.tmpdir(), "wr-agent-"));
  const work = path.join(top, "work");
  mkdirSync(path.join(work, "pr-head", "app"), { recursive: true });
  mkdirSync(path.join(work, "pr-head", ".git"), { recursive: true });
  mkdirSync(path.join(work, "input"), { recursive: true });
  mkdirSync(path.join(work, "rulebook"), { recursive: true });
  writeFileSync(path.join(top, "outside.txt"), "RUNNER SECRET\n");
  writeFileSync(path.join(work, "pr-head", "app", "views.py"), ["import db", "", "def search():", "    term = request.args.get('q')", "    db.execute('SELECT * FROM t WHERE x = ' + term)", ""].join("\n"));
  writeFileSync(path.join(work, "pr-head", "app", "blob.bin"), Buffer.from([1, 0, 2, 3]));
  writeFileSync(path.join(work, "pr-head", ".git", "config"), "execute\n");
  writeFileSync(path.join(work, "input", "diff.patch"), DIFF);
  writeFileSync(path.join(work, "rulebook", "checks.md"), "# Injection\n");
  // Built at runtime: links the pull request could carry.
  symlinkSync(path.join(top, "outside.txt"), path.join(work, "pr-head", "leak.txt"));
  symlinkSync(top, path.join(work, "pr-head", "up"));
  symlinkSync("app/views.py", path.join(work, "pr-head", "inside-link.py"));
  return { top, work, done: () => rmSync(top, { recursive: true, force: true }) };
}

function tools(work, { maxComments = 2, post } = {}) {
  const posted = [];
  const t = makeTools({
    cwd: work,
    roots: [
      { name: "pr-head", dir: "pr-head" },
      { name: "input", dir: "input" },
      { name: "rulebook", dir: "rulebook" },
    ],
    codeRoot: "pr-head",
    changed: parseDiff(DIFF),
    maxComments,
    post: post || (async (c) => posted.push(c)),
  });
  return { t, posted };
}

test("read_file reads inside the roots, with line numbers and paging", async () => {
  const w = workspace();
  try {
    const { t } = tools(w.work);
    const r = await t.run("read_file", { path: "pr-head/app/views.py", offset: 4, limit: 1 });
    assert.equal(r.isError, false);
    assert.match(r.content, /^4\t {4}term = request/);
    assert.match(r.content, /more line\(s\); read on with offset 5/);
    assert.equal((await t.run("read_file", { path: "rulebook/checks.md" })).content, "1\t# Injection\n2\t\n");
    assert.equal((await t.run("read_file", { path: "pr-head/inside-link.py" })).isError, false);
    assert.match((await t.run("read_file", { path: "pr-head/app/blob.bin" })).content, /binary/);
    assert.match((await t.run("read_file", { path: "pr-head/app" })).content, /not a file/);
  } finally {
    w.done();
  }
});

test("read_file refuses ../, absolute paths and symlinks that lead out of the roots", async () => {
  const w = workspace();
  try {
    const { t } = tools(w.work);
    for (const p of ["pr-head/leak.txt", "pr-head/up/outside.txt", "pr-head/../../outside.txt", path.join(w.top, "outside.txt"), "/etc/hosts"]) {
      const r = await t.run("read_file", { path: p });
      assert.equal(r.isError, true, p);
      assert.doesNotMatch(r.content, /RUNNER SECRET/, p);
    }
    assert.match((await t.run("read_file", { path: "pr-head/leak.txt" })).content, /outside the files this review may read/);
    assert.ok(t.stats.rejected.badPath >= 4);
  } finally {
    w.done();
  }
});

test("grep searches the code, shows root-relative paths, skips .git and links out", async () => {
  const w = workspace();
  try {
    const { t } = tools(w.work);
    const r = await t.run("grep", { pattern: "execute|SECRET" });
    assert.equal(r.isError, false);
    assert.equal(r.content, "pr-head/app/views.py:5:    db.execute('SELECT * FROM t WHERE x = ' + term)");
    assert.equal((await t.run("grep", { pattern: "nothing-here" })).content, "no matches");
    assert.match((await t.run("grep", { pattern: "INJECTION", path: "rulebook", ignore_case: true })).content, /^rulebook\/checks\.md:1:/);
    assert.equal((await t.run("grep", { pattern: "x", path: "pr-head/up" })).isError, true);
    assert.match((await t.run("grep", { pattern: "(" })).content, /grep failed/);
    assert.match((await t.run("grep", { pattern: "--version" })).content, /no matches/);
  } finally {
    w.done();
  }
});

test("grep's child process gets no API key or token", async () => {
  const w = workspace();
  const bin = path.join(w.top, "bin");
  const dump = path.join(w.top, "env.txt");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "grep"), `#!/bin/sh\nenv > '${dump}'\nexit 1\n`);
  chmodSync(path.join(bin, "grep"), 0o755);
  const saved = { PATH: process.env.PATH, REVIEW_API_KEY: process.env.REVIEW_API_KEY, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.REVIEW_API_KEY = "sk-must-not-leak";
  process.env.GITHUB_TOKEN = "ghs-must-not-leak";
  try {
    const { t } = tools(w.work);
    assert.equal((await t.run("grep", { pattern: "x" })).content, "no matches");
    const env = readFileSync(dump, "utf8");
    assert.doesNotMatch(env, /must-not-leak/);
    assert.match(env, /^LC_ALL=C$/m);
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    w.done();
  }
});

test("glob lists files by pattern without following links or entering .git", async () => {
  const w = workspace();
  try {
    const { t } = tools(w.work);
    assert.equal((await t.run("glob", { pattern: "**/*.py" })).content, "pr-head/app/views.py");
    assert.equal((await t.run("glob", { pattern: "**/config" })).content, "no files match");
    assert.equal((await t.run("glob", { pattern: "*.md", path: "rulebook" })).content, "rulebook/checks.md");
    assert.equal((await t.run("glob", { pattern: "*", path: "pr-head/up" })).isError, true);
  } finally {
    w.done();
  }
});

test("create_inline_comment posts on changed lines only, and stops at the limit", async () => {
  const w = workspace();
  try {
    const { t, posted } = tools(w.work, { maxComments: 2 });
    const off = await t.run("create_inline_comment", { path: "app/views.py", line: 3, body: "x" });
    assert.equal(off.isError, true);
    assert.match(off.content, /not a line this change added or modified/);
    assert.equal((await t.run("create_inline_comment", { path: "app/views.py", start_line: 3, line: 4, body: "x" })).isError, true);
    assert.equal((await t.run("create_inline_comment", { path: "app/other.py", line: 4, body: "x" })).isError, true);
    assert.equal((await t.run("create_inline_comment", { path: "app/views.py", line: 5, body: "   " })).isError, true);
    assert.equal((await t.run("create_inline_comment", { path: "app/views.py", line: 5, body: "SQL injection" })).content, "posted on app/views.py:5");
    assert.equal((await t.run("create_inline_comment", { path: "pr-head/app/views.py", start_line: 4, line: 5, body: "range" })).isError, false);
    const over = await t.run("create_inline_comment", { path: "app/views.py", line: 4, body: "third" });
    assert.match(over.content, /limit of 2 comments/);
    assert.deepEqual(posted, [
      { path: "app/views.py", line: 5, body: "SQL injection" },
      { path: "app/views.py", line: 5, start_line: 4, body: "range" },
    ]);
    assert.deepEqual(t.stats, { posted: 2, rejected: { offDiff: 3, overLimit: 1, badPath: 0 } });
  } finally {
    w.done();
  }
});

test("a comment GitHub refuses is a tool error, not a crash", async () => {
  const w = workspace();
  try {
    const { t } = tools(w.work, {
      post: async () => {
        throw Object.assign(new Error("POST /repos/x/pulls/1/comments: 422 nope"), { status: 422 });
      },
    });
    const r = await t.run("create_inline_comment", { path: "app/views.py", line: 5, body: "x" });
    assert.equal(r.isError, true);
    assert.match(r.content, /GitHub did not take the comment \(422 POST \/repos\/x\/pulls\/1\/comments\)/);
    assert.equal(t.stats.posted, 0);
  } finally {
    w.done();
  }
});

test("inputs are checked against the schema, and unknown tools are refused", async () => {
  assert.equal(badInput(TOOLS[0].schema, { path: "a" }), null);
  assert.match(badInput(TOOLS[0].schema, {}), /"path" is required/);
  assert.match(badInput(TOOLS[0].schema, { path: "a", offset: 1.5 }), /integer/);
  assert.match(badInput(TOOLS[0].schema, { path: "a", command: "rm" }), /unknown field/);
  assert.match(badInput(TOOLS[0].schema, ["a"]), /not an object/);
  const w = workspace();
  try {
    const { t } = tools(w.work);
    assert.deepEqual(await t.run("Bash", { command: "env" }), { content: 'there is no tool "Bash"', isError: true });
  } finally {
    w.done();
  }
});

test("the tools are exactly the four", () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ["read_file", "grep", "glob", "create_inline_comment"]);
});

// A scripted Anthropic endpoint: each reply in turn.
const reply = (body, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const toolUse = (id, name, input) => reply({ content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 100, output_tokens: 10 }, stop_reason: "tool_use" });

test("runReview: tool calls, then a final answer; the log has tool names only", async () => {
  const w = workspace();
  try {
    const { t, posted } = tools(w.work);
    const replies = [
      toolUse("a", "read_file", { path: "pr-head/app/views.py" }),
      reply({
        content: [
          { type: "tool_use", id: "b", name: "create_inline_comment", input: { path: "app/views.py", line: 5, body: "SQL injection: term reaches execute." } },
          { type: "tool_use", id: "c", name: "::warning::spoofed", input: {} },
        ],
        usage: { input_tokens: 200, output_tokens: 20 },
      }),
      reply({ content: [{ type: "text", text: "Posted 1 comment." }], usage: { input_tokens: 300, output_tokens: 5 }, stop_reason: "end_turn" }),
    ];
    const sent = [];
    const fetchImpl = async (url, init) => {
      sent.push(JSON.parse(init.body));
      return replies.shift();
    };
    const log = [];
    const a = adapter({ provider: "anthropic", apiKey: "k" });
    const out = await runReview({ adapter: a, prompt: "review", tools: t, log: (l) => log.push(l), sendOptions: { fetchImpl, sleep: async () => {} } });
    assert.equal(out.status, "ran");
    assert.equal(out.turns, 3);
    assert.deepEqual(out.calls, [
      { name: "read_file", ok: true },
      { name: "create_inline_comment", ok: true },
      { name: "(unknown tool)", ok: false },
    ]);
    assert.deepEqual(out.usage, { input: 600, output: 35 });
    assert.equal(out.posted, 1);
    assert.equal(posted.length, 1);
    assert.deepEqual(log, ["turn 1: read_file ok", "turn 2: create_inline_comment ok", "turn 2: (unknown tool) error"]);
    assert.ok(!log.join("\n").includes("SELECT"));
    // The second request carried the file back as a tool result.
    assert.match(JSON.stringify(sent[1].messages.at(-1)), /tool_result.*db\.execute/);
  } finally {
    w.done();
  }
});

test("runReview: a provider error ends the run as failed, with its message", async () => {
  const w = workspace();
  try {
    const { t } = tools(w.work);
    const fetchImpl = async () => reply({ type: "error", error: { message: "Your credit balance is too low to access the Anthropic API." } }, 400);
    const out = await runReview({ adapter: adapter({ provider: "anthropic", apiKey: "k" }), prompt: "p", tools: t, log: () => {}, sendOptions: { fetchImpl } });
    assert.equal(out.status, "failed");
    assert.equal(out.turns, 1);
    assert.match(out.error, /400: Your credit balance is too low/);
  } finally {
    w.done();
  }
});

test("runReview: the turn limit and the deadline stop a model that never finishes", async () => {
  const w = workspace();
  try {
    const { t } = tools(w.work);
    const fetchImpl = async () => toolUse("x", "glob", { pattern: "*" });
    const a = adapter({ provider: "anthropic", apiKey: "k" });
    const capped = await runReview({ adapter: a, prompt: "p", tools: t, maxTurns: 3, log: () => {}, sendOptions: { fetchImpl } });
    assert.equal(capped.status, "failed");
    assert.equal(capped.turns, 3);
    assert.match(capped.error, /turn limit \(3\)/);
    let clock = 0;
    const late = await runReview({ adapter: a, prompt: "p", tools: t, deadline: 2, now: () => clock++, log: () => {}, sendOptions: { fetchImpl } });
    assert.match(late.error, /time limit, after 3 turn/);
  } finally {
    w.done();
  }
});

test("runReview works the same through the OpenAI adapter", async () => {
  const w = workspace();
  try {
    const { t } = tools(w.work);
    const replies = [
      reply({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "grep", arguments: '{"pattern":"execute"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      reply({ choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } }),
    ];
    const sent = [];
    const fetchImpl = async (url, init) => {
      sent.push(JSON.parse(init.body));
      return replies.shift();
    };
    const out = await runReview({ adapter: adapter({ provider: "openai", apiKey: "k", model: "gpt-5.1" }), prompt: "p", tools: t, log: () => {}, sendOptions: { fetchImpl } });
    assert.equal(out.status, "ran");
    assert.deepEqual(out.calls, [{ name: "grep", ok: true }]);
    assert.deepEqual(sent[1].messages.at(-1), { role: "tool", tool_call_id: "c1", content: "pr-head/app/views.py:5:    db.execute('SELECT * FROM t WHERE x = ' + term)" });
  } finally {
    w.done();
  }
});

test("logSafe keeps a provider's text from becoming a workflow command", () => {
  assert.equal(logSafe("::error::x\n::add-mask::y"), "error::x ::add-mask::y");
  assert.equal(logSafe("a\r\nb"), "a b");
});

test("review.mjs run with no key writes a failed run.json and exits 1, without calling anyone", () => {
  const w = workspace();
  try {
    writeFileSync(path.join(w.work, "prompt.md"), "review");
    const cli = new URL("../plugins/wolfproof-review/scripts/review.mjs", import.meta.url).pathname;
    const env = { ...process.env };
    delete env.REVIEW_API_KEY;
    const r = spawnSync(process.execPath, [cli, "run", "--provider", "anthropic", "--prompt", "prompt.md", "--code-dir", "pr-head", "--input-dir", "input", "--rulebook-dir", "rulebook", "--diff", "input/diff.patch", "--max-comments", "5", "--out", "run.json"], { cwd: w.work, env, encoding: "utf8" });
    assert.equal(r.status, 1);
    const out = JSON.parse(readFileSync(path.join(w.work, "run.json"), "utf8"));
    assert.equal(out.status, "failed");
    assert.equal(out.error, "no API key");
    assert.match(r.stdout, /::warning::wolfproof-review: the review did not finish: no API key/);
  } finally {
    w.done();
  }
});
