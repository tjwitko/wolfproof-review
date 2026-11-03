import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MARKER,
  parseDiff,
  onChangedLine,
  globToRegExp,
  checkOf,
  locationsIn,
  sortFindings,
  renderSummary,
  offDiff,
  buildPrompt,
  stripFrontMatter,
} from "../plugins/wolfproof-review/scripts/lib.mjs";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const result = JSON.parse(fx("result.json"));
const diff = fx("change.diff");
const files = fx("files.txt").split("\n").filter(Boolean);

// The fixture: a legacy Flask app with two SQL injections and a command injection already in it. The
// change adds a /search route with a third SQL injection at app/views.py:22 and a pinned dependency.

test("the diff gives the new-side lines each file gained", () => {
  const d = parseDiff(diff);
  assert.deepEqual(d.get("app/views.py").ranges, [[17, 23]]);
  assert.deepEqual(d.get("requirements.txt").ranges, [[2, 2]]);
  assert.ok(onChangedLine(d, "app/views.py", 22));
  assert.ok(!onChangedLine(d, "app/views.py", 16));
  assert.ok(!onChangedLine(d, "lib/run.js", 4));
});

test("a deletion-only hunk and a deleted file add no lines", () => {
  const d = parseDiff(
    ["diff --git a/x.js b/x.js", "--- a/x.js", "+++ b/x.js", "@@ -3,2 +2,0 @@", "-a", "-b", "diff --git a/gone.js b/gone.js", "--- a/gone.js", "+++ /dev/null", "@@ -1,3 +0,0 @@"].join("\n")
  );
  assert.deepEqual(d.get("x.js").ranges, []);
  assert.ok(!d.has("gone.js"));
});

test("locations are files that exist, with their lines; addresses and images are not", () => {
  const set = new Set(["src/index.js", "Dockerfile", "main.tf"]);
  assert.deepEqual(locationsIn("GET /health (src/index.js:26, probe)", set), [{ file: "src/index.js", line: 26 }]);
  assert.deepEqual(locationsIn("ingress from 0.0.0.0:0 on node:20-alpine", set), []);
  assert.deepEqual(locationsIn("dockerfile: Dockerfile builds on a base image past end of life — line 1 FROM node:20-alpine", set), [{ file: "Dockerfile", line: 1 }]);
  assert.deepEqual(locationsIn("x: /work/p/main.tf:12 and main.tf", set, "/work/p"), [{ file: "main.tf", line: 12 }]);
  assert.deepEqual(locationsIn("workload identity: src/index.js: a connection string", set), [{ file: "src/index.js", line: null }]);
});

test("each message's check is its prefix", () => {
  assert.equal(checkOf("sast: SQL injection — x"), "sast");
  assert.equal(checkOf("checkov (terraform): 23 finding(s)"), "checkov (terraform)");
  assert.equal(checkOf("workload identity: k8s/deployment.yaml: container"), "workload identity");
  assert.equal(checkOf("no prefix here"), "other");
});

test("globs match paths and the directories they name", () => {
  assert.ok(globToRegExp("vendor").test("vendor/a/b.js"));
  assert.ok(globToRegExp("**/*.min.js").test("a/b/c.min.js"));
  assert.ok(globToRegExp("**/*.min.js").test("c.min.js"));
  assert.ok(!globToRegExp("src/*.js").test("src/a/b.js"));
  assert.ok(globToRegExp("docs/**").test("docs/x/y.md"));
});

test("the new injection is on a changed line; the old ones are not", () => {
  const s = sortFindings({ result, diff, files, root: "/work/legacy" });
  const sql = s.findings.find((f) => f.check === "sast" && /SQL injection/.test(f.message));
  assert.equal(sql.group, "changed-line");
  assert.deepEqual(
    sql.locations.map((l) => [l.line, l.group]),
    [[10, "changed-file"], [16, "changed-file"], [22, "changed-line"]]
  );
  const cmd = s.findings.find((f) => /command injection/.test(f.message));
  assert.equal(cmd.group, "elsewhere");
  const auth = s.findings.find((f) => f.check === "authentication" && f.severity === "blocking");
  assert.equal(auth.group, "changed-line", "the new /search route at line 18 is on a changed line");
  assert.deepEqual(s.change, { files: 3, lines: 9, changedFiles: [".gitignore", "app/views.py", "requirements.txt"] });
});

test("a dependency finding with no file is related to a changed manifest", () => {
  // In the fixture, the advisory names requirements.txt itself, and the blocking one names only
  // package.json, which the change did not touch.
  const s = sortFindings({ result, diff, files, root: "/work/legacy" });
  const deps = s.findings.filter((f) => f.check === "check_dependencies");
  assert.equal(deps.find((f) => f.severity === "blocking").group, "elsewhere");
  assert.equal(deps.find((f) => f.severity === "advisory").group, "changed-file");
  // With no file named at all, the finding is related to the changed manifest.
  const bare = { exitCode: 1, blocking: 1, findings: [{ severity: "blocking", message: "check_dependencies: 2 finding(s) at or above high severity" }], advisories: [] };
  const [f] = sortFindings({ result: bare, diff, files }).findings;
  assert.equal(f.group, "changed-file");
  assert.deepEqual(f.related, ["requirements.txt"]);
});

test("ignored paths drop their findings and leave the change", () => {
  const s = sortFindings({ result, diff, files, root: "/work/legacy", ignore: ["app/**"] });
  assert.ok(!s.findings.some((f) => /SQL injection/.test(f.message)));
  assert.ok(s.counts.ignored >= 1);
  assert.ok(!s.change.changedFiles.includes("app/views.py"));
});

test("no result: nothing sorted, and the summary says the scan did not run", () => {
  const s = sortFindings({ result: null, diff, files, meta: { head: "abcdef123", scanNote: "The scan job failed." } });
  assert.equal(s.scan.ran, false);
  const body = renderSummary(s, { claude: { status: "no-key" } });
  assert.match(body, /wolfproof did not produce a result for `abcdef1`/);
  assert.match(body, /The scan job failed\./);
  assert.match(body, /no `ANTHROPIC_API_KEY` secret/);
});

test("the summary leads with changed lines and folds what was already there", () => {
  const s = sortFindings({ result, diff, files, root: "/work/legacy", meta: { head: "1234567890", wolfproof: "v1.15.0", reviewVersion: "v0.1.0" } });
  const body = renderSummary(s, { claude: { status: "ran", posted: 2, offDiff: [] } });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /wolfproof v1\.15\.0 scanned `1234567`: \*\*blocked\*\*/);
  const changed = body.indexOf("#### On lines this change added or modified");
  const folded = body.indexOf("<details><summary>Already in the repository");
  assert.ok(changed > 0 && folded > changed);
  assert.match(body.slice(changed, folded), /`app\/views\.py:22`/);
  assert.match(body.slice(folded), /command injection/);
  assert.match(body, /2 inline comment\(s\) on changed lines/);
});

test("the summary cannot be closed or used to ping anyone by the text it quotes", () => {
  const evil = { exitCode: 1, blocking: 1, findings: [{ severity: "blocking", message: "sast: x </details> @someone app/views.py:22" }], advisories: [] };
  const body = renderSummary(sortFindings({ result: evil, diff, files }), {});
  assert.ok(!/<\/details> @someone/.test(body));
  assert.match(body, /&lt;\/details> @​someone/);
});

test("comments off the diff are caught, multi-line ones included", () => {
  const d = parseDiff(diff);
  const comments = [
    { path: "app/views.py", line: 22 },
    { path: "app/views.py", line: 10 },
    { path: "app/views.py", start_line: 16, line: 18 },
    { path: "lib/run.js", line: 4 },
  ];
  assert.deepEqual(offDiff(comments, d), [
    { path: "app/views.py", line: 10 },
    { path: "app/views.py", line: 18 },
    { path: "lib/run.js", line: 4 },
  ]);
});

test("the prompt is the agent's instructions with this run after them", () => {
  const agent = readFileSync(new URL("../plugins/wolfproof-review/agents/wolfproof-reviewer.md", import.meta.url), "utf8");
  assert.ok(!stripFrontMatter(agent).startsWith("---"));
  const p = buildPrompt(agent, { mode: "ci", codeDir: "pr-head", diffPath: "in/diff.patch", sortedPath: "in/sorted.json", rulebookPath: "rb/checks.md", existingPath: "in/existing.json", maxComments: 15, changedLines: 9, largeChange: 1500 });
  assert.match(p, /^You review one change/);
  assert.match(p, /## This run/);
  assert.match(p, /without the `pr-head\/` prefix/);
  assert.match(p, /At most 15 comments/);
  assert.ok(!/large/.test(p.split("## This run")[1]));
  const local = buildPrompt(agent, { mode: "local", codeDir: "/repo", diffPath: "d", sortedPath: "s", rulebookPath: "r", maxComments: 15, changedLines: 4000, largeChange: 1500 });
  assert.match(local, /local — print the review/);
  assert.ok(!/mcp__github_inline_comment/.test(local.split("## This run")[1]));
  assert.match(local, /This change is large \(4000/);
});

test("a real wolfproof result with infrastructure findings sorts without a diff", () => {
  const haiku = JSON.parse(fx("haiku3-result.json"));
  const s = sortFindings({ result: haiku, diff: "", files: ["src/index.js", "src/database.js", "k8s/deployment.yaml", "Dockerfile"], root: "/work/haiku3" });
  assert.equal(s.counts["changed-line"], 0);
  assert.equal(s.counts["changed-file"], 0);
  const docker = s.findings.find((f) => f.check === "dockerfile");
  assert.deepEqual(docker.locations.map((l) => [l.file, l.line]), [["Dockerfile", 1]]);
});
