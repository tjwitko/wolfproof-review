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

test("PLAN.md names the versions the workflows pin", () => {
  // Dependabot moves the pins; this keeps PLAN's "Pinned:" line from going stale behind it.
  const line = /^- Pinned: ([\s\S]*?)\.\n/m.exec(read("PLAN.md"))?.[1];
  assert.ok(line, "PLAN.md has a \"- Pinned:\" line");
  const named = [...line.matchAll(/`([\w./-]+)` (v\d+\.\d+\.\d+)/g)];
  assert.ok(named.length >= 4, line);
  const workflows = read(".github/workflows/review.yml") + read(".github/workflows/ci.yml");
  for (const [, action, version] of named) {
    const pinned = [...workflows.matchAll(/uses: ([\w.-]+\/[\w.-]+)@[0-9a-f]{40} # (v\S+)/g)]
      .filter(([, ref]) => ref === action || ref.endsWith(`/${action}`))
      .map((m) => m[2]);
    assert.ok(pinned.length > 0, `no workflow pins ${action}`);
    assert.deepEqual([...new Set(pinned)], [version], `PLAN.md says ${action} ${version}`);
  }
});

test("the marketplace lists the plugin at its folder", () => {
  const market = JSON.parse(read(".claude-plugin/marketplace.json"));
  const plugin = JSON.parse(read("plugins/wolfproof-review/.claude-plugin/plugin.json"));
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [[plugin.name, "./plugins/wolfproof-review"]]);
});

test("the plugin's hooks run scripts that exist, on the commands that open a pull request", () => {
  const hooks = JSON.parse(read("plugins/wolfproof-review/hooks/hooks.json")).hooks;
  assert.deepEqual(Object.keys(hooks), ["PreToolUse"]);
  const handlers = hooks.PreToolUse.flatMap((m) => {
    assert.equal(m.matcher, "Bash");
    return m.hooks;
  });
  assert.deepEqual(handlers.map((h) => h.if), ["Bash(gh pr create*)", "Bash(gh pr new*)"]);
  for (const h of handlers) {
    const [, script] = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+)"$/.exec(h.command) || [];
    assert.ok(script, h.command);
    read(`plugins/wolfproof-review/${script}`);
  }
});

test("the reviewer's tools are read-only, and only the review step holds the key", async () => {
  // Locally, Claude Code runs the agent with these tools; in the workflow, agent.mjs's four.
  const agent = read("plugins/wolfproof-review/agents/wolfproof-reviewer.md");
  assert.match(agent, /^tools: Read, Grep, Glob$/m);
  const { TOOLS } = await import("../plugins/wolfproof-review/scripts/agent.mjs");
  assert.deepEqual(TOOLS.map((t) => t.name), ["read_file", "grep", "glob", "create_inline_comment"]);
  for (const file of [".github/workflows/review.yml", ".github/workflows/ci.yml", ".github/workflows/self-review.yml"]) {
    assert.doesNotMatch(read(file), /claude-code-action/, file);
  }
  // Each step of the review job, by name: only "Review" has the key in its environment.
  const [jobHead, ...steps] = workflow.slice(workflow.indexOf("  review:\n")).split(/\n      - name: /);
  assert.doesNotMatch(jobHead, /secrets\./, "the review job's own env holds no secret");
  // The decide step only learns whether a key exists (HAS_KEY, true or false).
  const withKey = steps.filter((st) => st.split("\n").some((l) => /secrets\.(REVIEW|ANTHROPIC)_API_KEY/.test(l) && !/^\s*HAS_KEY:/.test(l)));
  assert.deepEqual(withKey.map((st) => st.split("\n")[0]), ["Review"]);
  assert.match(workflow, /node "\$CLI" run --provider/);
});
