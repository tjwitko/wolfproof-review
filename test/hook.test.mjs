// The pull-request hook: which commands it stops, and that a local review of HEAD lets them through.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { prCreate, sameBase } from "../plugins/wolfproof-review/scripts/lib.mjs";
import { decide } from "../plugins/wolfproof-review/scripts/pr-hook.mjs";

const SCRIPTS = fileURLToPath(new URL("../plugins/wolfproof-review/scripts/", import.meta.url));

test("prCreate finds gh pr create and its base, and nothing else", () => {
  assert.deepEqual(prCreate("gh pr create --fill"), { base: null });
  assert.deepEqual(prCreate("gh pr new"), { base: null });
  assert.deepEqual(prCreate("git push -u origin HEAD && gh pr create --base develop --fill"), { base: "develop" });
  assert.deepEqual(prCreate("gh pr create --base=main --title x"), { base: "main" });
  assert.deepEqual(prCreate("gh pr create -B 'release/1.2' --fill"), { base: "release/1.2" });
  assert.deepEqual(prCreate("cd app && gh  pr  create"), { base: null });
  // A -B that belongs to the next command is not this one's base.
  assert.deepEqual(prCreate("gh pr create --fill; git checkout -B other"), { base: null });
  for (const c of ["gh pr list", "gh pr view 3", "gh pr creates", "echo ghpr create", "git commit -m 'x'", ""]) assert.equal(prCreate(c), null, c);
});

test("sameBase ignores origin/ and accepts a pull request that names no base", () => {
  assert.ok(sameBase("main", null));
  assert.ok(sameBase("origin/main", "main"));
  assert.ok(sameBase("main", "origin/main"));
  assert.ok(!sameBase("main", "develop"));
});

function repo() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wr-hook-")));
  const tmp = path.join(dir, "tmp");
  const work = path.join(dir, "work");
  mkdirSync(tmp);
  mkdirSync(work);
  const git = (...a) => {
    const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: work, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(work, "app.py"), "print('hello')\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("switch", "-qc", "feature");
  writeFileSync(path.join(work, "app.py"), "print('hello')\nprint('more')\n");
  git("commit", "-qam", "change");
  const review = (...args) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, "review.mjs"), "local", ...args], { cwd: work, encoding: "utf8", env: { ...process.env, TMPDIR: tmp } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  return { dir, tmp, work, git, review, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const bash = (cwd, command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd });

test("a pull request is stopped until HEAD is reviewed, and again after a new commit", () => {
  const r = repo();
  try {
    const env = {};
    const at = (command) => decide(bash(r.work, command), { env, tmp: r.tmp });
    // Other commands and other tools are never touched.
    assert.equal(at("git status"), null);
    assert.equal(decide({ tool_name: "Read", tool_input: { file_path: "x" }, cwd: r.work }, { env, tmp: r.tmp }), null);

    assert.match(at("gh pr create --fill"), /^Not opening the pull request yet: this repository's commit [0-9a-f]{7} has not been reviewed/);
    assert.match(at("gh pr create --fill"), /run the \/wolfproof-review command, or prepare it directly with `node ".*review\.mjs" local`/);

    r.review("main", "--no-scan");
    assert.equal(at("gh pr create --fill"), null);
    assert.equal(at("gh pr create --base main --fill"), null);
    // Reviewed against main, so a pull request into another branch needs its own review.
    assert.match(at("gh pr create --base develop"), /the last wolfproof review was against main, and this pull request goes to develop/);
    assert.match(at("gh pr create --base develop"), /with the argument develop/);

    writeFileSync(path.join(r.work, "app.py"), "print('changed again')\n");
    r.git("commit", "-qam", "after the review");
    assert.match(at("gh pr create --fill"), /the last wolfproof review was of commit [0-9a-f]{7}, and HEAD is now [0-9a-f]{7}/);
    // Off, by the user's environment.
    assert.equal(decide(bash(r.work, "gh pr create"), { env: { WOLFPROOF_REVIEW_HOOK: "off" }, tmp: r.tmp }), null);
  } finally {
    r.done();
  }
});

test("the review is found from the git directory even when the hook sees another temporary directory", () => {
  const r = repo();
  try {
    r.review("main", "--no-scan");
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), "wr-other-"));
    try {
      assert.equal(decide(bash(r.work, "gh pr create"), { env: {}, tmp: elsewhere }), null);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  } finally {
    r.done();
  }
});

test("outside a repository the hook lets the call through", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wr-norepo-"));
  try {
    assert.equal(decide(bash(dir, "gh pr create"), { env: {}, tmp: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run as a hook: a deny in Claude Code's JSON, or no output at all", () => {
  const r = repo();
  try {
    const run = (input) =>
      spawnSync(process.execPath, [path.join(SCRIPTS, "pr-hook.mjs")], {
        input: typeof input === "string" ? input : JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, TMPDIR: r.tmp, WOLFPROOF_REVIEW_HOOK: "" },
      });
    const denied = run(bash(r.work, "gh pr create --fill"));
    assert.equal(denied.status, 0, denied.stderr);
    const out = JSON.parse(denied.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /has not been reviewed/);

    for (const input of [bash(r.work, "ls"), "not json"]) {
      const p = run(input);
      assert.equal(p.status, 0, p.stderr);
      assert.equal(p.stdout, "");
    }
    r.review("main", "--no-scan");
    assert.equal(run(bash(r.work, "gh pr create --fill")).stdout, "");
  } finally {
    r.done();
  }
});
