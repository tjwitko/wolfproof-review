// The diff the review works from, made by the workflow's own git command in a real repository built
// here, then read by parseDiff and the comment tool. Each case is something a pull request controls:
// the content of its lines and its .gitattributes.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseDiff, onChangedLine, changedFromPatches, diffDisagreement, offDiff } from "../plugins/wolfproof-review/scripts/lib.mjs";
import { makeTools } from "../plugins/wolfproof-review/scripts/agent.mjs";

const workflow = readFileSync(new URL("../.github/workflows/review.yml", import.meta.url), "utf8");

// The scan job's two lines that make diff.patch, as the workflow has them.
const scanStep = workflow.slice(workflow.indexOf('out="$RUNNER_TEMP/wolfproof-review-input"'));
const noattrLine = /^ *(noattr=\$\(git hash-object -t tree \/dev\/null\))$/m.exec(scanStep)[1];
const diffLine = /^ *(git --attr-source="\$noattr" [^\n]*> "\$out\/diff\.patch")$/m.exec(scanStep)[1];

const G = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];

/**
 * A repository with one commit of `base` files, then one of `head` files; the workflow's diff of the
 * two. With `withPatches`, also each file as GitHub's pulls/{pr}/files has it: its hunks with three
 * lines of context and no headers.
 */
function diffOf(base, head, { withPatches = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wr-diff-"));
  const git = (...a) => execFileSync("git", [...G, ...a], { cwd: dir, encoding: "utf8" });
  try {
    git("init", "-q");
    const write = (files) => {
      for (const [f, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        writeFileSync(path.join(dir, f), body);
      }
      git("add", "-A");
    };
    write(base);
    git("commit", "-q", "-m", "base");
    write(head);
    git("commit", "-q", "-m", "head");
    const out = path.join(dir, "out");
    mkdirSync(out);
    execFileSync("bash", ["-ec", `${noattrLine}\n${diffLine}`], {
      cwd: dir,
      env: { PATH: process.env.PATH, base: git("rev-parse", "HEAD~1").trim(), HEAD_SHA: git("rev-parse", "HEAD").trim(), out },
    });
    const diff = readFileSync(path.join(out, "diff.patch"), "utf8");
    if (!withPatches) return diff;
    const names = git("diff", "--name-only", "HEAD~1", "HEAD").split("\n").filter(Boolean);
    const files = names.map((filename) => {
      const p = git("diff", "--text", "-U3", "HEAD~1", "HEAD", "--", filename);
      return { filename, status: "modified", patch: p.slice(p.indexOf("@@")).replace(/\n$/, "") };
    });
    return { diff, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lines = (n, f = (i) => `x${i} = ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";
// Line 3 gains `added`, and line 15 (16 after the insert) changes, so the file has two hunks.
const twoHunks = (added) => {
  const l = lines(20).split("\n");
  l.splice(2, 0, added);
  l[15] = "x15 = 'changed'";
  return l.join("\n");
};

async function comment(diff, c) {
  const top = mkdtempSync(path.join(os.tmpdir(), "wr-diff-tools-"));
  try {
    mkdirSync(path.join(top, "pr-head"));
    const posted = [];
    const t = makeTools({ cwd: top, roots: [{ name: "pr-head", dir: "pr-head" }], codeRoot: "pr-head", changed: parseDiff(diff), maxComments: 5, post: async (x) => posted.push(x) });
    const r = await t.run("create_inline_comment", c);
    return { ...r, posted };
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
}

for (const added of ["++ b/other.py", "++ /dev/null"]) {
  test(`an added line reading "${added}" is a line of its file, not a file header`, async () => {
    const diff = diffOf({ "app.py": lines(20) }, { "app.py": twoHunks(added) });
    assert.ok(diff.includes(`\n+${added}\n`), "git writes it as a +++ line");
    const d = parseDiff(diff);
    assert.deepEqual([...d.keys()], ["app.py"]);
    assert.deepEqual(d.get("app.py").ranges, [[3, 3], [16, 16]]);
    assert.ok(onChangedLine(d, "app.py", 16));

    const later = await comment(diff, { path: "app.py", line: 16, body: "later hunk" });
    assert.equal(later.isError, false);
    assert.deepEqual(later.posted, [{ path: "app.py", line: 16, body: "later hunk" }]);
    const other = await comment(diff, { path: "other.py", line: 16, body: "x" });
    assert.equal(other.isError, true);
    assert.match(other.content, /not a line this change added or modified/);
  });
}

for (const attr of ["*.py -diff", "*.py binary"]) {
  test(`a .gitattributes "${attr}" in the pull request does not hide its lines; a real binary stays out`, async () => {
    const diff = diffOf({ "app.py": lines(5) }, { "app.py": lines(6), ".gitattributes": `${attr}\n`, "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 10]) });
    assert.doesNotMatch(diff, /Binary files \S+ and b\/app\.py differ/);
    assert.match(diff, /Binary files \/dev\/null and b\/logo\.png differ/);
    assert.ok(!diff.includes("\0"), "no binary bytes in diff.patch, which the model reads");
    const d = parseDiff(diff);
    assert.deepEqual(d.get("app.py").ranges, [[6, 6]]);
    assert.equal((await comment(diff, { path: "app.py", line: 6, body: "x" })).isError, false);
  });
}

test("parseDiff: a body shorter than its header credits nothing more, and the next header still counts", () => {
  const d = parseDiff(["diff --git a/a.py b/a.py", "--- a/a.py", "+++ b/a.py", "@@ -1,0 +2,3 @@", "+one", "diff --git a/b.py b/b.py", "--- a/b.py", "+++ b/b.py", "@@ -0,0 +1 @@", "+two"].join("\n"));
  assert.deepEqual(d.get("a.py").ranges, [[2, 4]]);
  assert.deepEqual(d.get("b.py").ranges, [[1, 1]]);
});

test("GitHub's patches, context and all, give the same changed lines as this job's -U0 diff", () => {
  const l = lines(40).split("\n");
  l.splice(2, 0, "++ b/other.py");
  l[20] = "x20 = 'changed'";
  l.splice(30, 2);
  const { diff, files } = diffOf({ "app.py": lines(40), "keep.py": lines(3) }, { "app.py": l.join("\n"), "keep.py": lines(3) + "y = 1\n", ".gitattributes": "*.py -diff\n" }, { withPatches: true });
  const { changed, unknown } = changedFromPatches(files);
  assert.equal(unknown.size, 0);
  assert.deepEqual(changed.get("app.py").ranges, [[3, 3], [21, 21]]);
  assert.deepEqual(changed.get("keep.py").ranges, [[4, 4]]);
  assert.deepEqual(diffDisagreement(parseDiff(diff), changed), []);
});

test("changedFromPatches: only + lines count; a file without a patch cannot be checked", () => {
  const files = [
    { filename: "a.py", status: "modified", patch: "@@ -1,4 +1,5 @@\n ctx\n-old\n+new\n+newer\n ctx\n ctx\n@@ -20,3 +21,3 @@ def f():\n ctx\n-x\n+y\n ctx" },
    { filename: "big.min.js", status: "modified", changes: 9000 },
    { filename: "logo.png", status: "added", changes: 0 },
    { filename: "moved.py", status: "renamed", changes: 0 },
    { filename: "gone.py", status: "removed", changes: 3 },
  ];
  const { changed, unknown } = changedFromPatches(files);
  assert.deepEqual(changed.get("a.py").ranges, [[2, 3], [22, 22]]);
  assert.deepEqual(changed.get("moved.py").ranges, []);
  assert.deepEqual([...unknown], ["big.min.js"]);
  assert.ok(!changed.has("gone.py"));
  const comments = [
    { path: "a.py", line: 3, start_line: 2 },
    { path: "a.py", line: 4 },
    { path: "moved.py", line: 1 },
  ];
  assert.deepEqual(offDiff(comments, changed), [{ path: "a.py", line: 4 }, { path: "moved.py", line: 1 }]);
  // Where the two diffs part, the check's log says so.
  const ours = parseDiff(["diff --git a/a.py b/a.py", "--- a/a.py", "+++ b/a.py", "@@ -2 +2,2 @@", "-old", "+new", "+newer"].join("\n"));
  assert.deepEqual(diffDisagreement(ours, changed, unknown), ["a.py"]);
});
