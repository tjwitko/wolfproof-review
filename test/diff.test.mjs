// The diff the review works from, made by the workflow's own git command in a real repository built
// here, then read by parseDiff and the comment tool. Each case is something a pull request controls:
// the content of its lines and its .gitattributes.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseDiff, onChangedLine, changedFromPatches, diffDisagreement, offDiff, sortFindings } from "../plugins/wolfproof-review/scripts/lib.mjs";
import { makeTools } from "../plugins/wolfproof-review/scripts/agent.mjs";

const workflow = readFileSync(new URL("../.github/workflows/review.yml", import.meta.url), "utf8");

// The scan job's two lines that make diff.patch, as the workflow has them.
const scanStep = workflow.slice(workflow.indexOf('out="$RUNNER_TEMP/wolfproof-review-input"'));
const noattrLine = /^ *(noattr=\$\(git hash-object -t tree \/dev\/null\))$/m.exec(scanStep)[1];
const diffLine = /^ *(git --attr-source="\$noattr" [^\n]*> "\$out\/diff\.patch")$/m.exec(scanStep)[1];
const filesLine = /^ *(git [^\n]*ls-files[^\n]*> "\$out\/files\.txt")$/m.exec(scanStep)[1];

const G = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];

/**
 * A repository with one commit of `base` files, then one of `head` files; the workflow's diff of the
 * two. With `withPatches`, also each file as GitHub's pulls/{pr}/files has it: its hunks with three
 * lines of context and no headers.
 */
function diffOf(base, head, { withPatches = false, withFiles = false } = {}) {
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
    execFileSync("bash", ["-ec", `${noattrLine}\n${diffLine}\n${filesLine}`], {
      cwd: dir,
      env: { PATH: process.env.PATH, base: git("rev-parse", "HEAD~1").trim(), HEAD_SHA: git("rev-parse", "HEAD").trim(), out },
    });
    const diff = readFileSync(path.join(out, "diff.patch"), "utf8");
    if (withFiles) return { diff, filesTxt: readFileSync(path.join(out, "files.txt"), "utf8") };
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

// Names git writes with a tab after them ("+++ b/victim.py \t"), built here so no such file sits in
// this repository.
const TRAILING = "victim.py" + " ";
const INSIDE = ["sp", "ace.py"].join(" ");
const LEADING = " " + "lead.py";

test("a new file whose name ends in a space keeps its own lines, not the unchanged file it resembles", async () => {
  const diff = diffOf({ "victim.py": lines(30) }, { [TRAILING]: lines(25) });
  assert.ok(diff.includes(`+++ b/${TRAILING}\t\n`), "git ends the header with a tab");
  const d = parseDiff(diff);
  assert.deepEqual([...d.keys()], [TRAILING]);
  assert.deepEqual(d.get(TRAILING).ranges, [[1, 25]]);
  assert.ok(!onChangedLine(d, "victim.py", 20));

  const wrong = await comment(diff, { path: "victim.py", line: 20, body: "x" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content, /not a line this change added or modified/);
  assert.equal((await comment(diff, { path: TRAILING, line: 20, body: "x" })).isError, false);

  // A scanner finding on the unchanged file is not sorted as on the change.
  const result = { exitCode: 1, findings: [{ severity: "blocking", message: "sast: SQL injection — victim.py:20" }] };
  const s = sortFindings({ result, diff, files: ["victim.py", TRAILING] });
  assert.equal(s.findings[0].group, "elsewhere");
  assert.deepEqual(s.change.changedFiles, [TRAILING]);
});

test("a name with a space inside it gets its lines", async () => {
  const diff = diffOf({ "keep.py": lines(3) }, { [INSIDE]: lines(4) });
  const d = parseDiff(diff);
  assert.deepEqual([...d.keys()], [INSIDE]);
  assert.deepEqual(d.get(INSIDE).ranges, [[1, 4]]);
  assert.equal((await comment(diff, { path: INSIDE, line: 2, body: "x" })).isError, false);
});

test("a name with a leading space gets its lines, and the file list keeps the space", async () => {
  const diff = diffOf({ "keep.py": lines(3) }, { [LEADING]: lines(2) });
  const d = parseDiff(diff);
  assert.deepEqual([...d.keys()], [LEADING]);
  assert.deepEqual(d.get(LEADING).ranges, [[1, 2]]);
  assert.equal((await comment(diff, { path: LEADING, line: 1, body: "x" })).isError, false);
  assert.equal((await comment(diff, { path: "lead.py", line: 1, body: "x" })).isError, true);

  // review.mjs sort reads files.txt as git ls-files writes it: " lead.py" is not "lead.py".
  const dir = mkdtempSync(path.join(os.tmpdir(), "wr-sort-"));
  try {
    const at = (n) => path.join(dir, n);
    writeFileSync(at("diff.patch"), diff);
    writeFileSync(at("files.txt"), `keep.py\n${LEADING}\n`);
    writeFileSync(at("result.json"), JSON.stringify({ exitCode: 1, findings: [{ severity: "blocking", message: "sast: SQL injection — lead.py:1" }] }));
    const cli = new URL("../plugins/wolfproof-review/scripts/review.mjs", import.meta.url).pathname;
    const r = spawnSync(process.execPath, [cli, "sort", "--result", at("result.json"), "--diff", at("diff.patch"), "--files", at("files.txt"), "--out", at("sorted.json")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const sorted = JSON.parse(readFileSync(at("sorted.json"), "utf8"));
    assert.deepEqual(sorted.change.changedFiles, [LEADING]);
    assert.deepEqual(sorted.findings[0].locations, [{ file: LEADING, line: 1, group: "changed-line" }], "lead.py is not a file of this repository");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Where a finding is, when its file's name has a space or has to be quoted ---------------------

const CLI = new URL("../plugins/wolfproof-review/scripts/review.mjs", import.meta.url).pathname;

/**
 * The scan job's diff.patch and files.txt for a change from `base` to `head`, then review.mjs sort
 * over them with wolfproof findings whose messages are `messages`; the sorted findings, in order.
 */
function sortedIn(base, head, messages, { root } = {}) {
  const { diff, filesTxt } = diffOf(base, head, { withFiles: true });
  const dir = mkdtempSync(path.join(os.tmpdir(), "wr-sort-"));
  try {
    const at = (n) => path.join(dir, n);
    writeFileSync(at("diff.patch"), diff);
    writeFileSync(at("files.txt"), filesTxt);
    writeFileSync(at("result.json"), JSON.stringify({ exitCode: 1, findings: messages.map((message) => ({ severity: "blocking", message })) }));
    const args = ["sort", "--result", at("result.json"), "--diff", at("diff.patch"), "--files", at("files.txt"), "--out", at("sorted.json")];
    if (root) args.push("--root", root);
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const sorted = JSON.parse(readFileSync(at("sorted.json"), "utf8"));
    const byMessage = new Map(sorted.findings.map((f) => [f.message, f]));
    return { diff, sorted, findings: messages.map((m) => byMessage.get(m)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const where = (f) => [f.group, f.locations.map((l) => [l.file, l.line, l.group])];
const XACE = ["x", "ace.py"].join(" ");
const YACE = ["y", "ace.py"].join(" ");

test("a finding in a new file with a space in its name sorts with the change: on its line, or in its file", () => {
  // y ace.py was there already; the change edits its line 3 only.
  const yBefore = lines(30);
  const yAfter = yBefore.replace("x3 = 3", "x3 = 'changed'");
  const { findings } = sortedIn(
    { "keep.py": lines(3), [YACE]: yBefore },
    { [XACE]: lines(25), [YACE]: yAfter },
    [`sast: SQL injection — ${XACE}:20`, `sast: SQL injection — /work/p/${YACE}:20`],
    { root: "/work/p" }
  );
  assert.deepEqual(where(findings[0]), ["changed-line", [[XACE, 20, "changed-line"]]]);
  assert.deepEqual(where(findings[1]), ["changed-file", [[YACE, 20, "changed-file"]]]);
});

test("beside an unchanged ace.py, x ace.py:20 is the new file's line, and ace.py:20 is still elsewhere", () => {
  const { findings } = sortedIn({ "ace.py": lines(30) }, { [XACE]: lines(25) }, [`sast: SQL injection — ${XACE}:20`, "sast: SQL injection — ace.py:20"]);
  assert.deepEqual(where(findings[0]), ["changed-line", [[XACE, 20, "changed-line"]]]);
  assert.deepEqual(where(findings[1]), ["elsewhere", [["ace.py", 20, "elsewhere"]]]);
});

test("a space at either end of a name counts where the message sets it apart, and the unchanged twin stays elsewhere", () => {
  const { findings } = sortedIn(
    { "victim.py": lines(30), "lead.py": lines(30) },
    { [TRAILING]: lines(25), [LEADING]: lines(25) },
    [
      `sast: SQL injection — ${TRAILING}:20`, // "victim.py :20"
      "sast: SQL injection — victim.py:20",
      "sast: SQL injection — victim.py — line 20",
      `sast: SQL injection —  ${LEADING.trimStart()}:20`, // two spaces: the separator and the name's own
      "sast: SQL injection — lead.py:20",
    ]
  );
  assert.deepEqual(where(findings[0]), ["changed-line", [[TRAILING, 20, "changed-line"]]]);
  assert.deepEqual(where(findings[1]), ["elsewhere", [["victim.py", 20, "elsewhere"]]]);
  assert.deepEqual(where(findings[2]), ["elsewhere", [["victim.py", 20, "elsewhere"]]]);
  assert.deepEqual(where(findings[3]), ["changed-line", [[LEADING, 20, "changed-line"]]]);
  assert.deepEqual(where(findings[4]), ["elsewhere", [["lead.py", 20, "elsewhere"]]]);
});

test("names git quotes (a tab, a double quote, a backslash, a newline) are read as the names they are", async () => {
  const odd = ["t\tab.py", 'q"uote.py', ["back", "slash.py"].join("\\"), "nl\nx.py", ["sp ace", "tab.py"].join("\t")];
  const head = Object.fromEntries(odd.map((n) => [n, lines(5)]));
  const { diff, findings } = sortedIn({ "keep.py": lines(3) }, head, odd.map((n) => `sast: SQL injection — ${n}:3`));
  assert.ok(diff.includes('+++ "b/t\\tab.py"'), "git quotes the name in the header");
  const d = parseDiff(diff);
  assert.deepEqual([...d.keys()].sort(), [...odd].sort());
  for (const [i, n] of odd.entries()) {
    assert.deepEqual(d.get(n).ranges, [[1, 5]], JSON.stringify(n));
    assert.deepEqual(where(findings[i]), ["changed-line", [[n, 3, "changed-line"]]], JSON.stringify(n));
    assert.equal((await comment(diff, { path: n, line: 3, body: "x" })).isError, false, JSON.stringify(n));
  }
});
