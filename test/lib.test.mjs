import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MARKER,
  parseDiff,
  onChangedLine,
  globToRegExp,
  checkOf,
  locationsIn,
  sortFindings,
  renderSummary,
  reviewOutcome,
  finalStatus,
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
  const body = renderSummary(s, { review: { status: "no-key" } });
  assert.match(body, /wolfproof did not produce a result for `abcdef1`/);
  assert.match(body, /The scan job failed\./);
  assert.match(body, /no `REVIEW_API_KEY` secret \(or `ANTHROPIC_API_KEY`, for the Anthropic provider with no `base-url`\)/);
});

test("a run stopped at its input-token budget says so, with the budget and what it posted", () => {
  const s = sortFindings({ result, diff, files, meta: { head: "abcdef123" } });
  const body = renderSummary(s, { review: { status: "failed", stopped: "input-tokens", maxInputTokens: 1000000, posted: 2, note: "stopped at the input-token budget (1000000), after 9 turn(s) that used 980000" } });
  assert.match(body, /stopped at its input-token budget of 1000000 tokens, before it finished/);
  assert.match(body, /`max-input-tokens` input sets the budget/);
  assert.match(body, /posted 2 inline comment\(s\) before it stopped/);
  assert.doesNotMatch(body, /The review failed/);
});

test("the summary leads with changed lines and folds what was already there", () => {
  const s = sortFindings({ result, diff, files, root: "/work/legacy", meta: { head: "1234567890", wolfproof: "v1.15.0", reviewVersion: "v0.1.0" } });
  const body = renderSummary(s, { review: { status: "ran", model: "claude-sonnet-5-5", posted: 2, offDiff: [] } });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /wolfproof v1\.15\.0 scanned `1234567`: \*\*blocked\*\*/);
  const changed = body.indexOf("#### On lines this change added or modified");
  const folded = body.indexOf("<details><summary>Already in the repository");
  assert.ok(changed > 0 && folded > changed);
  assert.match(body.slice(changed, folded), /`app\/views\.py:22`/);
  assert.match(body.slice(folded), /command injection/);
  assert.match(body, /#### Review by `claude-sonnet-5-5`\n\n2 inline comment\(s\) on changed lines/);
});

test("a failed review shows the provider's error, what it posted, and comments off the diff", () => {
  const s = sortFindings({ result, diff, files });
  const body = renderSummary(s, { review: { status: "failed", model: "gpt-5.1", posted: 1, note: "anthropic answered 400: Your credit balance is too low", offDiff: [{ path: "a.py", line: 3 }] } });
  assert.match(body, /#### Review by `gpt-5\.1`/);
  assert.match(body, /The review failed: anthropic answered 400: Your credit balance is too low\./);
  assert.match(body, /It posted 1 inline comment\(s\) before it stopped/);
  assert.match(body, /1 comment\(s\) landed on lines this change did not modify: `a\.py:3`/);
  assert.doesNotMatch(body, /Claude/);
});

test("the summary cannot be closed or used to ping anyone by the text it quotes", () => {
  const evil = { exitCode: 1, blocking: 1, findings: [{ severity: "blocking", message: "sast: x </details> @someone app/views.py:22" }], advisories: [] };
  const body = renderSummary(sortFindings({ result: evil, diff, files }), {});
  assert.ok(!/<\/details> @someone/.test(body));
  assert.match(body, /&lt;\/details> @​someone/);
});

test("a file name in the summary stays inside its code span: spaces, backticks and newlines included", () => {
  // The pull request picks its file names; one with a backtick or a newline must not close the span,
  // end the list, or ping anyone.
  const spaced = ["x", "ace.py"].join(" ");
  const evil = ["a`@someone`", "</details>.py"].join("\n");
  const r = { exitCode: 1, blocking: 2, findings: [{ severity: "blocking", message: `sast: x — ${spaced}:20` }, { severity: "blocking", message: `sast: y — ${evil}:1` }], advisories: [] };
  const body = renderSummary(sortFindings({ result: r, diff: "", files: [spaced, evil] }), {});
  assert.match(body, /`x ace\.py:20`/);
  assert.ok(body.includes("`` a`@someone`\\x0a</details>.py:1 ``"), body);
  assert.equal(body.split("\n").filter((l) => l === "</details>").length, 1, "only the summary's own </details> starts a line");
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
  assert.match(p, /the `create_inline_comment` tool/);
  assert.match(p, /`read_file`.*`grep`.*`glob`/);
  assert.ok(!/mcp__/.test(p));
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

test("the summary warns when the scan's diff did not match the pull request's commits", () => {
  const plain = renderSummary(sortFindings({ result, diff, files, meta: { head: "abc1234" } }), {});
  assert.doesNotMatch(plain, /did not match/);
  const forged = renderSummary(sortFindings({ result, diff, files, meta: { head: "abc1234", diffMismatch: true } }), {});
  assert.match(forged, /> ⚠️ The scan job's diff did not match the pull request's commits, so this review used the diff it computed itself/);
});

// An unfinished review. On one pull request the review stopped at its budget on three of seven heads,
// and each time the check was green and the only sign was a sentence under the scanner's findings.

test("a review that was due and did not finish is told from one that finished and one that was not due", () => {
  assert.equal(reviewOutcome("ran"), "finished");
  for (const s of ["failed", "no-scan"]) assert.equal(reviewOutcome(s), "unfinished", s);
  for (const s of ["no-key", "fork", "not-run", undefined]) assert.equal(reviewOutcome(s), "skipped", String(s));
  // The plan said run: run.json decides, and none at all is a review that failed.
  assert.equal(finalStatus("run", { status: "ran" }), "ran");
  assert.equal(finalStatus("run", { status: "failed", stopped: "input-tokens" }), "failed");
  assert.equal(finalStatus("run", null), "failed");
  // A run.json is not read for a review the plan did not start.
  assert.equal(finalStatus("no-key", { status: "ran" }), "no-key");
  assert.equal(finalStatus("fork", null), "fork");
  assert.equal(finalStatus("", null), "no-scan");
  assert.equal(finalStatus(undefined, null), "no-scan");
});

test("the summary opens with the unfinished review, before the scanner's findings", () => {
  const s = sortFindings({ result, diff, files, meta: { head: "abcdef123" } });
  const lineOf = (body, re) => body.split("\n").findIndex((l) => re.test(l));
  const budget = { status: "failed", stopped: "input-tokens", maxInputTokens: 1000000, posted: 2, note: "stopped at the input-token budget (1000000), after 9 turn(s) that used 980000" };

  const warn = renderSummary(s, { review: budget });
  assert.equal(warn.split("\n")[3], "> ⚠️ **The model's review did not finish.** It stopped at its input-token budget of 1000000 tokens, after 2 inline comment(s), so part of this change was not reviewed. The review check still passes. Set `on-unfinished: fail` in the calling workflow to make it fail instead.");
  assert.ok(lineOf(warn, /did not finish/) < lineOf(warn, /wolfproof .*scanned/), "above the scanner's line");
  assert.match(renderSummary(s, { review: { ...budget, onUnfinished: "warn" } }), /The review check still passes\./);

  const fail = renderSummary(s, { review: { ...budget, onUnfinished: "fail" } });
  assert.match(fail.split("\n")[3], /so part of this change was not reviewed\. The review check fails for this, because the calling workflow sets `on-unfinished: fail`\.$/);
  assert.doesNotMatch(fail, /still passes/);

  // Any other failure: the reason the run gave, once, with no doubled full stop.
  const cut = renderSummary(s, { review: { status: "failed", note: "stopped at the turn limit (60).", posted: 0 } });
  assert.match(cut.split("\n")[3], /^> ⚠️ \*\*The model's review did not finish\.\*\* stopped at the turn limit \(60\)\. Part of this change may not have been reviewed\. /);
  const bare = renderSummary(s, { review: { status: "failed", posted: 1 } });
  assert.match(bare.split("\n")[3], /did not finish\.\*\* It failed, after 1 inline comment\(s\)\. Part of this change may not have been reviewed\./);
  // A scan that left nothing: the review never started.
  assert.match(renderSummary(s, { review: { status: "no-scan" } }).split("\n")[3], /^> ⚠️ \*\*The model's review did not run\.\*\* The scan job left nothing to review\. /);

  // A finished review, and one that was not due, open as before.
  for (const status of ["ran", "no-key", "fork", "not-run"]) {
    const body = renderSummary(s, { review: { status, posted: 0, onUnfinished: "fail" } });
    assert.doesNotMatch(body, /review did not finish|review did not run|on-unfinished/, status);
    assert.match(body.split("\n")[3], /^wolfproof .*scanned/, status);
  }
  // A reason is the run's own text: its first line only, with HTML and mentions escaped as elsewhere.
  const odd = renderSummary(s, { review: { status: "failed", note: "HTTP 500 <b>x</b> @someone\n## heading\n> quote" } });
  const top = odd.split("\n")[3];
  assert.match(top, /did not finish\.\*\* HTTP 500 &lt;b>x&lt;\/b> @\u200bsomeone\. Part of this change/);
  assert.doesNotMatch(top, /heading|quote|<b>/);
  assert.equal(odd.split("\n")[4], "");
});

test("the scanner's line promises only what holds with on-unfinished: fail", () => {
  const s = sortFindings({ result, diff, files, meta: { head: "abcdef123" } });
  const body = renderSummary(s, { review: { status: "ran", posted: 0 } });
  assert.match(body, /This review is comment-only: no finding fails the build\./);
  assert.doesNotMatch(body, /does not fail the build/);
});

test("the outcome command writes the job's outputs, and fails the step only when asked to and only for an unfinished review", () => {
  const cli = fileURLToPath(new URL("../plugins/wolfproof-review/scripts/review.mjs", import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), "outcome-"));
  try {
    const runFile = (o) => {
      const f = path.join(dir, `run-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(f, JSON.stringify(o));
      return f;
    };
    const run = (...args) => {
      const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}`);
      writeFileSync(out, "");
      const r = spawnSync(process.execPath, [cli, "outcome", ...args], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: out } });
      return { code: r.status, text: r.stdout + r.stderr, outputs: readFileSync(out, "utf8") };
    };
    const stopped = runFile({ status: "failed", stopped: "input-tokens", error: "stopped at the input-token budget (1000000), after 9 turn(s) that used 980000" });
    const ran = runFile({ status: "ran" });

    // Unfinished, the default and warn: outputs say so, the step passes.
    for (const mode of [[], ["--on-unfinished=warn"], ["--on-unfinished="]]) {
      const r = run("--plan=run", "--run", stopped, ...mode);
      assert.equal(r.code, 0, mode.join());
      assert.equal(r.outputs, "finished=false\noutcome=unfinished\n");
      assert.doesNotMatch(r.text, /::error::/);
    }
    // Unfinished, fail: the step fails, with one error annotation that gives the reason.
    const f = run("--plan=run", "--run", stopped, "--on-unfinished=fail");
    assert.equal(f.code, 1);
    assert.equal(f.outputs, "finished=false\noutcome=unfinished\n");
    assert.match(f.text, /^::error::wolfproof-review: the review did not finish: stopped at the input-token budget \(1000000\), after 9 turn\(s\) that used 980000\. This job fails because on-unfinished is fail\.$/m);
    // The review step was killed and left nothing; the scan left nothing.
    assert.match(run("--plan=run", "--on-unfinished=fail").text, /did not finish: the review step left no result\./);
    assert.equal(run("--plan=run", "--on-unfinished=fail").code, 1);
    const noScan = run("--plan=", "--on-unfinished=fail");
    assert.equal(noScan.code, 1);
    assert.match(noScan.text, /did not finish: the scan job left nothing to review\./);
    assert.equal(run("--plan=no-scan", "--on-unfinished=fail").code, 1);

    // Finished: passes in both modes. Not due: passes in both, and is not called finished.
    for (const mode of ["warn", "fail"]) {
      const ok = run("--plan=run", "--run", ran, `--on-unfinished=${mode}`);
      assert.equal(ok.code, 0, mode);
      assert.equal(ok.outputs, "finished=true\noutcome=finished\n");
      for (const plan of ["no-key", "fork"]) {
        const skipped = run(`--plan=${plan}`, `--on-unfinished=${mode}`);
        assert.equal(skipped.code, 0, `${plan} ${mode}`);
        assert.equal(skipped.outputs, "finished=false\noutcome=skipped\n");
      }
    }
    // An error that tries to write a workflow command of its own stays on the one line.
    const sly = run("--plan=run", "--run", runFile({ status: "failed", error: "boom\n::error::forged" }), "--on-unfinished=fail");
    assert.equal(sly.text.split("\n").filter((l) => l.startsWith("::")).length, 1);
    // A value that is neither is a usage error, not a pass.
    const bad = run("--plan=run", "--run", stopped, "--on-unfinished=maybe");
    assert.equal(bad.code, 2);
    assert.match(bad.text, /on-unfinished is warn or fail, not "maybe"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
