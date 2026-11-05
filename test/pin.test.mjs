// scripts/pin-wolfproof.mjs: the edits that move the reviewer to a new wolfproof release.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FILES, actionOutputs, changedPaths, pinEdits } from "../scripts/pin-wolfproof.mjs";

const read = (k) => readFileSync(new URL(`../${FILES[k]}`, import.meta.url), "utf8");
const files = () => ({ workflow: read("workflow"), readme: read("readme"), plugin: read("plugin") });
const env = (text, name) => new RegExp(`^ {2}${name}: (\\S+)$`, "m").exec(text)[1];

test("a pin moves every wolfproof reference and the reviewer's own version one patch up", () => {
  const f = files();
  const prev = env(f.workflow, "WOLFPROOF_VERSION");
  const [maj, min, pat] = JSON.parse(f.plugin).version.split(".").map(Number);
  const plan = pinEdits(f, "v9.8.7");
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.prev, prev);
  assert.equal(plan.reviewNext, `v${maj}.${min}.${pat + 1}`);

  const { workflow, readme, plugin } = plan.out;
  assert.equal(env(workflow, "WOLFPROOF_VERSION"), "v9.8.7");
  assert.equal(env(workflow, "REVIEW_VERSION"), plan.reviewNext);
  assert.deepEqual([...workflow.matchAll(/uses: tjwitko\/wolfproof(?:\/[^@\s]*)?@(\S+)/g)].map((m) => m[1]), ["v9.8.7", "v9.8.7"]);
  assert.equal(JSON.parse(plugin).version, plan.reviewNext.slice(1));
  assert.ok(readme.includes("github:tjwitko/wolfproof#v9.8.7"));
  assert.ok(readme.includes(`review.yml@${plan.reviewNext}`));
  for (const text of [workflow, readme]) assert.ok(!text.includes(prev), "the old wolfproof version is gone");
  // Only version strings move.
  const shape = (t) => t.replace(/v?\d+\.\d+\.\d+/g, "V");
  assert.equal(shape(workflow), shape(f.workflow));
  assert.equal(shape(readme), shape(f.readme));
  assert.equal(shape(plugin), shape(f.plugin));
});

test("a pin stops when the files are not in the shape it expects", () => {
  const f = files();
  const prev = env(f.workflow, "WOLFPROOF_VERSION");
  const oneLine = { ...f, workflow: f.workflow.replace(`uses: tjwitko/wolfproof@${prev}`, "uses: tjwitko/wolfproof@main") };
  assert.match(pinEdits(oneLine, "v9.8.7").problems.join("\n"), /1 tjwitko\/wolfproof uses: lines at .*, not 2/);
  const noInstall = { ...f, readme: f.readme.replaceAll(`#${prev}`, "#main").replaceAll(`--branch ${prev}`, "--branch main") };
  assert.match(pinEdits(noInstall, "v9.8.7").problems.join("\n"), /README\.md has no wolfproof install line/);
  assert.match(pinEdits(f, "latest").problems.join("\n"), /latest is not a version/);
});

test("actionOutputs reads an Action's declared outputs", () => {
  const yml = "name: x\ninputs:\n  project:\n    default: .\noutputs:\n  outcome:\n    description: a\n    value: b\n\n  result:\n    value: c\nruns:\n  using: composite\n";
  assert.deepEqual(actionOutputs(yml), ["outcome", "result"]);
  assert.deepEqual(actionOutputs("name: x\nruns:\n  using: node20\n"), []);
});

test("changedPaths keeps every character of every path, the first included", () => {
  assert.deepEqual(changedPaths(" M .github/workflows/review.yml\0 M README.md\0?? new file.txt\0"), [".github/workflows/review.yml", "README.md", "new file.txt"]);
  assert.deepEqual(changedPaths("R  b.md\0a.md\0 M c.md\0"), ["b.md", "c.md"]);
  assert.deepEqual(changedPaths(""), []);
});
