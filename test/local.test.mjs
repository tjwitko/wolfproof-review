// The local review finds wolfproof in the project, or through WOLFPROOF_BIN.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { wolfproofCommand } from "../plugins/wolfproof-review/scripts/lib.mjs";

const REVIEW = fileURLToPath(new URL("../plugins/wolfproof-review/scripts/review.mjs", import.meta.url));

test("wolfproofCommand: the project's own install first, then WOLFPROOF_BIN in each form", () => {
  const files = new Set(["/repo/node_modules/wolfproof/bin/validate.mjs", "/opt/wolfproof/bin/validate.mjs", "/opt/wolfproof", "/opt/empty", "/usr/local/bin/wolfproof", "/home/me/wp/bin/validate.mjs"]);
  const dirs = new Set(["/opt/wolfproof", "/opt/empty"]);
  const fs = { exists: (p) => files.has(p), isDir: (p) => dirs.has(p) };
  const at = (root, bin) => wolfproofCommand(root, { WOLFPROOF_BIN: bin, HOME: "/home/me" }, fs, "node");

  // The version the project chose wins over the machine's.
  assert.deepEqual(at("/repo", "/opt/wolfproof"), { file: "node", args: ["/repo/node_modules/wolfproof/bin/validate.mjs"], via: "this project's node_modules/wolfproof" });
  assert.match(at("/other", "").note, /not installed in this project \(node_modules\/wolfproof\) and WOLFPROOF_BIN is not set/);
  assert.deepEqual(at("/other", "wolfproof"), { file: "wolfproof", args: [], via: "WOLFPROOF_BIN (wolfproof on PATH)" });
  assert.deepEqual(at("/other", "/opt/wolfproof/bin/validate.mjs"), { file: "node", args: ["/opt/wolfproof/bin/validate.mjs"], via: "WOLFPROOF_BIN (/opt/wolfproof/bin/validate.mjs)" });
  assert.deepEqual(at("/other", "/opt/wolfproof/"), { file: "node", args: ["/opt/wolfproof/bin/validate.mjs"], via: "WOLFPROOF_BIN (/opt/wolfproof/)" });
  assert.deepEqual(at("/other", "~/wp/bin/validate.mjs"), { file: "node", args: ["/home/me/wp/bin/validate.mjs"], via: "WOLFPROOF_BIN (~/wp/bin/validate.mjs)" });
  assert.deepEqual(at("/other", "/usr/local/bin/wolfproof"), { file: "/usr/local/bin/wolfproof", args: [], via: "WOLFPROOF_BIN (/usr/local/bin/wolfproof)" });
  assert.match(at("/other", "/opt/empty").note, /directory \/opt\/empty, which has no bin\/validate\.mjs/);
  assert.match(at("/other", "/nowhere/validate.mjs").note, /WOLFPROOF_BIN is set to \/nowhere\/validate\.mjs, which does not exist/);
});

// A repository with one change, and a stand-in for wolfproof outside it that reports one finding on
// the changed line, the way wolfproof's --json does.
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wr-local-")));
  const work = path.join(dir, "work");
  const tmp = path.join(dir, "tmp");
  const tools = path.join(dir, "tools");
  for (const d of [work, tmp, path.join(tools, "wolfproof", "bin")]) mkdirSync(d, { recursive: true });
  const git = (...a) => {
    const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: work, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(work, "app.py"), "import db\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("switch", "-qc", "feature");
  writeFileSync(path.join(work, "app.py"), "import db\ndb.run('SELECT * FROM t WHERE id=' + request.args['id'])\n");
  git("commit", "-qam", "change");

  const gate = path.join(tools, "wolfproof", "bin", "validate.mjs");
  writeFileSync(
    gate,
    `const project = process.cwd();
if (process.argv[2] !== "." || process.argv[3] !== "--json") process.exit(2);
console.log(JSON.stringify({ project, exitCode: 1, blocking: 1, incomplete: false, couldNotRun: [], reviewable: [],
  findings: [{ severity: "blocking", message: "sast: sql-injection — request data reaches a SQL statement: app.py:2" }], advisories: [] }));
`
  );
  const broken = path.join(tools, "broken.mjs");
  writeFileSync(broken, "process.stderr.write('boom'); process.exit(3);\n");
  chmodSync(gate, 0o755);
  const review = (bin) => {
    const env = { ...process.env, TMPDIR: tmp };
    delete env.WOLFPROOF_BIN;
    if (bin !== undefined) env.WOLFPROOF_BIN = bin;
    const r = spawnSync(process.execPath, [REVIEW, "local", "main"], { cwd: work, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const dirOf = /^instructions: (.*)$/m.exec(r.stdout)[1].replace(/\/prompt\.md$/, "");
    return { out: r.stdout, sorted: JSON.parse(readFileSync(path.join(dirOf, "sorted.json"), "utf8")) };
  };
  return { tools, gate, broken, review, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a local review runs the wolfproof WOLFPROOF_BIN names, and says when it could not", () => {
  const s = setup();
  try {
    for (const bin of [s.gate, path.join(s.tools, "wolfproof")]) {
      const { out, sorted } = s.review(bin);
      assert.match(out, new RegExp(`^wolfproof: WOLFPROOF_BIN \\(${bin.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\)$`, "m"));
      assert.doesNotMatch(out, /no scanner findings/);
      assert.ok(sorted.scan.ran);
      assert.deepEqual(sorted.findings.map((f) => [f.group, f.check]), [["changed-line", "sast"]]);
    }

    const none = s.review(undefined);
    assert.match(none.out, /WOLFPROOF_BIN is not set, so there are no scanner findings/);
    assert.ok(!none.sorted.scan.ran);

    assert.match(s.review("wolfproof-not-on-this-path").out, /wolfproof, from WOLFPROOF_BIN \(wolfproof-not-on-this-path on PATH\), did not produce a result \(it was not found\)/);
    assert.match(s.review(s.broken).out, /did not produce a result \(exit 3\)/);
  } finally {
    s.done();
  }
});
