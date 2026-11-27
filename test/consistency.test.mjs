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

test("the ANTHROPIC_API_KEY fallback holds only for Anthropic's own API, never for a base-url", () => {
  const uses = workflow.match(/secrets\.ANTHROPIC_API_KEY[^\n]*/g) || [];
  const lines = workflow.split("\n").filter((l) => l.includes("secrets.ANTHROPIC_API_KEY"));
  assert.equal(uses.length, 2, "HAS_KEY and the Review step's REVIEW_API_KEY");
  for (const l of lines) assert.match(l, /inputs\.provider == 'anthropic' && inputs\.base-url == '' && secrets\.ANTHROPIC_API_KEY/, l.trim());
  assert.match(workflow, /^ {10}HAS_KEY: \$\{\{ secrets\.REVIEW_API_KEY != '' \|\| \(inputs\.provider == 'anthropic' && inputs\.base-url == '' && secrets\.ANTHROPIC_API_KEY != ''\) \}\}$/m);
  assert.match(workflow, /^ {10}REVIEW_API_KEY: \$\{\{ secrets\.REVIEW_API_KEY \|\| \(inputs\.provider == 'anthropic' && inputs\.base-url == '' && secrets\.ANTHROPIC_API_KEY\) \|\| '' \}\}$/m);
});

test("the review has an input-token budget, checked and passed to the run", () => {
  assert.match(workflow, /max-input-tokens:\n\s+description: [^\n]+\n\s+type: number\n\s+default: 1000000\n/);
  assert.match(workflow, /BUDGET" =~ \^\[1-9\]\[0-9\]\{0,9\}\$/);
  assert.match(workflow, /--max-input-tokens "\$BUDGET"/);
  assert.match(read("plugins/wolfproof-review/scripts/review.mjs"), /const DEFAULT_MAX_INPUT_TOKENS = 1000000;/);
});

test("an unfinished review: an input the plan checks, a last step that alone can fail the job, and outputs for the caller", () => {
  assert.match(workflow, /\n      on-unfinished:\n\s+description: [^\n]+\n\s+type: string\n\s+default: warn\n/);
  assert.match(workflow, /if \[ "\$ON_UNFINISHED" != warn \] && \[ "\$ON_UNFINISHED" != fail \]; then\n\s+echo "::error::on-unfinished is warn or fail/);
  // The step is the job's last, runs unless the job was cancelled, and is not allowed to fail quietly.
  const steps = workflow.slice(workflow.indexOf("\n  review:\n")).split(/\n      - name: /).slice(1);
  const last = steps.at(-1);
  assert.match(last, /^Say whether the review finished\n\s+id: outcome\n\s+if: \$\{\{ !cancelled\(\) \}\}\n/);
  assert.doesNotMatch(last, /continue-on-error/);
  assert.match(last, /node "\$CLI" outcome "\$\{args\[@\]\}" --plan="\$STATUS" --on-unfinished="\$ON_UNFINISHED"/);
  // The summary is posted before it, and told the mode, so the comment says what the check did.
  assert.match(steps.at(-2), /^Post the summary\n[\s\S]*summary "\$\{args\[@\]\}" --status "\$status" --on-unfinished="\$ON_UNFINISHED" --post/);
  // The job hands the step's outputs to the workflow, and the workflow to its caller.
  assert.match(workflow, /\n    outputs:\n      finished: \$\{\{ steps\.outcome\.outputs\.finished \}\}\n      outcome: \$\{\{ steps\.outcome\.outputs\.outcome \}\}\n/);
  assert.match(workflow, /\n      finished:\n\s+description: [^\n]+\n\s+value: \$\{\{ jobs\.review\.outputs\.finished \}\}\n/);
  assert.match(workflow, /\n      outcome:\n\s+description: [^\n]+\n\s+value: \$\{\{ jobs\.review\.outputs\.outcome \}\}\n/);
  // The README gives the input and both outputs, and this repository's own reviews ask for fail.
  const readme = read("README.md");
  assert.match(readme, /\| `on-unfinished` \| `warn` \|/);
  assert.match(readme, /`finished`/);
  assert.match(read(".github/workflows/self-review.yml"), /\n      on-unfinished: fail\n/);
});

test("the review job keeps only the scan's own files, and reads its own results only when it ran", () => {
  const review = workflow.slice(workflow.indexOf("  review:\n"));
  const download = review.indexOf("- name: Download the scan");
  const trim = review.indexOf("- name: Keep only the scan's own files");
  const sort = review.indexOf("- name: Sort the findings");
  assert.ok(download > 0 && trim > download && sort > trim, "the trim runs after the download and before anything reads the files");
  assert.match(review, /find "\$IN" -mindepth 1 -maxdepth 1 \\\( ! -type f -o ! \\\( -name diff\.patch -o -name files\.txt -o -name result\.json -o -name meta\.json \\\) \\\) -exec rm -rf \{\} \+/);
  assert.match(workflow, /# Earlier steps ran the pull request's code[^\n]*\n {10}rm -rf "\$out"\n {10}mkdir -p "\$out"/);
  assert.match(review, /if \[ "\$STATUS" = run \]; then\n\s+\[ -f "\$IN\/run\.json" \]/);
  assert.match(review, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}[\s\S]*--head "\$HEAD_SHA"/);
});

test("the review job computes the diff from the pull request's commits, and everything uses it", () => {
  const review = workflow.slice(workflow.indexOf("  review:\n"));
  const at = (name) => review.indexOf(`- name: ${name}`);
  const trim = at("Keep only the scan's own files");
  const history = at("Check out the pull request's history, for the diff");
  const compute = at("Compute the change");
  assert.ok(trim > 0 && history > trim && compute > history, "after the artifact is trimmed");
  for (const later of ["Sort the findings", "Build the prompt", "Review", "Check where the comments landed"]) {
    assert.ok(at(later) > compute, `${later} comes after the diff is computed`);
  }
  const step = (name) => review.slice(at(name), review.indexOf("\n      - name: ", at(name) + 1));
  // The history: the head's full history, no stored credentials, in a folder the model cannot read.
  assert.match(step("Check out the pull request's history, for the diff"), /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\n\s+path: \.wolfproof-review-git\n\s+fetch-depth: 0\n\s+persist-credentials: false/);
  const c = step("Compute the change");
  assert.match(c, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(c, /merge-base "\$BASE_SHA" "\$HEAD_SHA"/);
  assert.match(c, /--attr-source="\$noattr" -c core\.quotePath=false diff --no-color --no-ext-diff -U0 -M "\$base" "\$HEAD_SHA" > "\$RUNNER_TEMP\/diff\.patch"/);
  assert.match(c, /mv "\$RUNNER_TEMP\/diff\.patch" "\$IN\/diff\.patch"/);
  assert.match(c, /mv "\$RUNNER_TEMP\/files\.txt" "\$IN\/files\.txt"/);
  assert.match(c, /rm -rf "\$d"/);
  assert.match(c, /\.diffMismatch = \$mismatch/);
  // The scan job's diff command is the same one, so on an honest run the two agree: the same flags, and
  // attributes from the same empty tree, so a .gitattributes in the pull request hides no lines.
  const scan = workflow.slice(0, workflow.indexOf("  review:\n"));
  const cmd = (text, git, out) => {
    const m = new RegExp(`^ *noattr=\\$\\(${git} hash-object -t tree /dev/null\\)\\n *${git} (--attr-source="\\$noattr" .*) > "${out}/diff\\.patch"$`, "m").exec(text);
    assert.ok(m, `the diff command writing ${out}/diff.patch`);
    return m[1];
  };
  assert.equal(cmd(c, 'git -C "\\$d"', "\\$RUNNER_TEMP"), cmd(scan, "git", "\\$out"));
  // The file list: names as they are, NUL-ended, in both jobs (a quoted name matches no file).
  assert.match(scan, /^ *git ls-files -z > "\$out\/files\.txt"$/m);
  assert.match(c, /^ *git -C "\$d" ls-files -z > "\$RUNNER_TEMP\/files\.txt"$/m);
  assert.match(read("plugins/wolfproof-review/scripts/review.mjs"), /git\(\["ls-files", "-z"\], cwd\)/);
  // Every reader takes $IN/diff.patch, which is now this job's own.
  assert.match(step("Sort the findings"), /--diff "\$IN\/diff\.patch" --files "\$IN\/files\.txt"/);
  assert.match(step("Build the prompt"), /--diff "\$IN\/diff\.patch"/);
  assert.match(step("Review"), /--diff "\$IN\/diff\.patch"/);
  assert.match(step("Check where the comments landed"), /--diff "\$IN\/diff\.patch"/);
  assert.doesNotMatch(step("Review"), /wolfproof-review-git/, "the model's tools never get the history");
});
