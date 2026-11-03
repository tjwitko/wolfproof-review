// The versions this repository pins, in the several places each one is written, agree.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/review.yml");
const envValue = (name) => new RegExp(`^  ${name}: (\\S+)$`, "m").exec(workflow)?.[1];

test("the workflow's wolfproof version matches its uses: pins and the rulebook copy", () => {
  const wolfproof = envValue("WOLFPROOF_VERSION");
  assert.match(wolfproof, /^v\d+\.\d+\.\d+$/);
  const pins = [...workflow.matchAll(/uses: tjwitko\/wolfproof(?:\/[^@\s]*)?@(\S+)/g)].map((m) => m[1]);
  assert.equal(pins.length, 2);
  assert.deepEqual(pins, [wolfproof, wolfproof]);
  assert.equal(JSON.parse(read("plugins/wolfproof-review/rulebook/SOURCE.json")).tag, wolfproof);
});

test("the workflow's own version matches the plugin's and the README's", () => {
  const review = envValue("REVIEW_VERSION");
  const plugin = JSON.parse(read("plugins/wolfproof-review/.claude-plugin/plugin.json")).version;
  assert.equal(review, `v${plugin}`);
  const readmePins = [...read("README.md").matchAll(/wolfproof-review\/\.github\/workflows\/review\.yml@(\S+)/g)].map((m) => m[1]);
  assert.ok(readmePins.length > 0);
  for (const p of readmePins) assert.equal(p, review);
  assert.match(workflow, new RegExp(`review\\.yml@${review.replace(/\./g, "\\.")}\\n`));
});

test("every third-party action is pinned to a full commit SHA", () => {
  for (const file of [".github/workflows/review.yml", ".github/workflows/ci.yml"]) {
    for (const [, ref] of read(file).matchAll(/uses: ([^\s#]+)/g)) {
      if (ref.startsWith("./") || ref.startsWith("tjwitko/") || ref.startsWith("docker://")) continue;
      assert.match(ref, /@[0-9a-f]{40}$/, `${file}: ${ref}`);
    }
  }
});

test("the marketplace lists the plugin at its folder", () => {
  const market = JSON.parse(read(".claude-plugin/marketplace.json"));
  const plugin = JSON.parse(read("plugins/wolfproof-review/.claude-plugin/plugin.json"));
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [[plugin.name, "./plugins/wolfproof-review"]]);
});

test("the agent's tools are read-only", () => {
  const agent = read("plugins/wolfproof-review/agents/wolfproof-reviewer.md");
  assert.match(agent, /^tools: Read, Grep, Glob$/m);
  assert.match(workflow, /--allowedTools "Read,Grep,Glob,mcp__github_inline_comment__create_inline_comment"/);
  assert.match(workflow, /--disallowedTools "Bash,/);
});
