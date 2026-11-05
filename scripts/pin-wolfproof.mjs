#!/usr/bin/env node
// Move wolfproof-review to a new wolfproof release, as one patch release of the reviewer.
//
//   node scripts/pin-wolfproof.mjs <wolfproof-version> [--commit --attribution="Co-Authored-By: ..."] [--push]
//
// It moves every place the wolfproof version is written, and the reviewer's own version with it,
// because installed copies of the plugin update only when that version changes:
//   - .github/workflows/review.yml: WOLFPROOF_VERSION, the two tjwitko/wolfproof uses: lines,
//     REVIEW_VERSION and the example's review.yml@ pin;
//   - plugins/wolfproof-review/rulebook/checks.md, copied from wolfproof's docs/checks.md at the tag,
//     and SOURCE.json;
//   - README.md: the wolfproof install lines and the review.yml@ pin;
//   - plugins/wolfproof-review/.claude-plugin/plugin.json: the reviewer's version, one patch up.
// Then it runs the tests, which check that the versions agree.
//
// Before editing, it checks the tag on GitHub: wolfproof's Action must still declare the two outputs
// the scan job reads (result, outcome), and the scanner-install action must exist there.
//
// Prints one line: PINNED, COMMITTED or PUSHED, ALREADY (nothing to do), or STOP with the reason. A
// STOP after editing leaves the edits for you to inspect. Exit 0 except on STOP.
// It never tags; a reviewer release tag is a separate decision.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FILES = {
  workflow: ".github/workflows/review.yml",
  readme: "README.md",
  plugin: "plugins/wolfproof-review/.claude-plugin/plugin.json",
  rulebook: "plugins/wolfproof-review/rulebook/checks.md",
  source: "plugins/wolfproof-review/rulebook/SOURCE.json",
};
const RAW = "https://raw.githubusercontent.com/tjwitko/wolfproof";
const EMAIL = "14301904+tjwitko@users.noreply.github.com";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const parse = (v) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(v) || []).slice(1).map(Number);
const newer = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** The outputs an Action declares, from its action.yml text. */
export function actionOutputs(yml) {
  const block = /^outputs:\n((?:[ \t].*\n|\n)*)/m.exec(String(yml).replace(/\r\n/g, "\n") + "\n");
  return block ? [...block[1].matchAll(/^ {2}([A-Za-z0-9_-]+):/gm)].map((m) => m[1]) : [];
}

/**
 * Every text edit, with no IO. `files` holds the current text of workflow, readme and plugin.
 * @returns {{prev, next, reviewPrev, reviewNext, out: {workflow, readme, plugin}, problems: string[]}}
 */
export function pinEdits(files, next) {
  const problems = [];
  next = `v${String(next).replace(/^v/, "")}`;
  const prev = /^ {2}WOLFPROOF_VERSION: (v\S+)$/m.exec(files.workflow)?.[1];
  const reviewPrev = /^ {2}REVIEW_VERSION: (v\S+)$/m.exec(files.workflow)?.[1];
  const plugin = JSON.parse(files.plugin);
  if (!prev || !reviewPrev) return { problems: ["review.yml names no WOLFPROOF_VERSION or REVIEW_VERSION"] };
  if (!parse(next).length) return { problems: [`${next} is not a version`] };
  const [maj, min, pat] = parse(plugin.version);
  const reviewNext = `v${maj}.${min}.${pat + 1}`;
  if (reviewPrev !== `v${plugin.version}`) problems.push(`review.yml's REVIEW_VERSION ${reviewPrev} differs from plugin.json's ${plugin.version}`);

  const count = (text, re) => (text.match(re) || []).length;
  const P = esc(prev);
  const R = esc(reviewPrev);
  let workflow = files.workflow;
  const usesRe = new RegExp(`(uses: tjwitko/wolfproof(?:/[^@\\s]*)?@)${P}(?![0-9])`, "g");
  if (count(workflow, usesRe) !== 2) problems.push(`review.yml has ${count(workflow, usesRe)} tjwitko/wolfproof uses: lines at ${prev}, not 2`);
  workflow = workflow
    .replace(usesRe, `$1${next}`)
    .replace(new RegExp(`^( {2}WOLFPROOF_VERSION: )${P}$`, "m"), `$1${next}`)
    .replace(new RegExp(`^( {2}REVIEW_VERSION: )${R}$`, "m"), `$1${reviewNext}`)
    .replace(new RegExp(`(review\\.yml@)${R}(?![0-9])`, "g"), `$1${reviewNext}`);

  let readme = files.readme;
  const installRe = new RegExp(`(github:tjwitko/wolfproof#|--branch )${P}(?![0-9])`, "g");
  if (!count(readme, installRe)) problems.push(`README.md has no wolfproof install line at ${prev}`);
  readme = readme.replace(installRe, `$1${next}`).replace(new RegExp(`(review\\.yml@)${R}(?![0-9])`, "g"), `$1${reviewNext}`);

  // Nothing pinned to the old version may be left, in either file.
  for (const [name, text] of [["review.yml", workflow], ["README.md", readme]]) {
    const left = text.split("\n").filter((l) => new RegExp(`(tjwitko/wolfproof|wolfproof-review|VERSION).*${P}(?![0-9])|${R}(?![0-9])`).test(l));
    for (const l of left) problems.push(`${name} still names an old version: ${l.trim()}`);
  }
  plugin.version = reviewNext.slice(1);
  return { prev, next, reviewPrev, reviewNext, out: { workflow, readme, plugin: `${JSON.stringify(plugin, null, 2)}\n` }, problems };
}

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

async function main(argv) {
  const opt = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const want = argv.find((a) => !a.startsWith("--"));
  const commit = argv.includes("--commit") || argv.includes("--push");
  const attribution = opt("attribution");
  if (!want || (commit && !attribution)) {
    console.error('usage: pin-wolfproof.mjs <wolfproof-version> [--commit --attribution="Co-Authored-By: ..."] [--push]');
    return 2;
  }
  const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
  const stop = (why) => (console.log(`STOP  wolfproof-review: ${why}`), 1);
  if (git("status", "--porcelain")) return stop("tree not clean");

  const read = (k) => readFileSync(path.join(ROOT, FILES[k]), "utf8");
  const plan = pinEdits({ workflow: read("workflow"), readme: read("readme"), plugin: read("plugin") }, want);
  if (plan.prev === plan.next) return console.log(`ALREADY wolfproof-review: pinned to wolfproof ${plan.next}`), 0;
  if (plan.prev && !newer(plan.next, plan.prev)) return stop(`wolfproof ${plan.next} is older than the current pin ${plan.prev}`);
  if (plan.problems.length) return stop(plan.problems.join("; "));

  let checks, action;
  try {
    action = await get(`${RAW}/${plan.next}/action.yml`);
    await get(`${RAW}/${plan.next}/.github/actions/control-tooling/action.yml`);
    checks = await get(`${RAW}/${plan.next}/docs/checks.md`);
  } catch (err) {
    return stop(`wolfproof ${plan.next} is not readable on GitHub (${err.message}); is it tagged and pushed?`);
  }
  const missing = ["result", "outcome"].filter((o) => !actionOutputs(action).includes(o));
  if (missing.length) return stop(`wolfproof ${plan.next}'s Action no longer declares the output(s) ${missing.join(", ")} that the scan job reads`);

  const write = (k, text) => writeFileSync(path.join(ROOT, FILES[k]), text);
  const rulebookMoved = checks !== read("rulebook");
  write("workflow", plan.out.workflow);
  write("readme", plan.out.readme);
  write("plugin", plan.out.plugin);
  write("rulebook", checks);
  const source = JSON.parse(read("source"));
  source.tag = plan.next;
  write("source", `${JSON.stringify(source, null, 2)}\n`);

  const t = spawnSync(process.execPath, ["--test", "test/*.test.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (t.status !== 0) return stop(`the tests fail after the edit; left uncommitted:\n${(t.stdout + t.stderr).split("\n").filter((l) => /^not ok|✖|Error/.test(l)).slice(0, 10).join("\n")}`);
  const changed = git("status", "--porcelain").split("\n").map((l) => l.slice(3));
  const extra = changed.filter((f) => !Object.values(FILES).includes(f));
  if (extra.length) return stop(`files outside the pin changed: ${extra.join(", ")}`);

  const what = `wolfproof ${plan.prev} -> ${plan.next}, reviewer ${plan.reviewPrev} -> ${plan.reviewNext}, rulebook ${rulebookMoved ? "changed" : "unchanged"}`;
  if (!commit) return console.log(`PINNED wolfproof-review: ${what} (not committed)`), 0;
  const r = spawnSync(
    "git",
    ["-c", `user.email=${EMAIL}`, "commit", "-q", "-m", `Pin wolfproof ${plan.next} (wolfproof-review ${plan.reviewNext})`, "-m", attribution, "--", ...changed],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (r.status !== 0) return stop(`commit failed: ${r.stderr.trim()}`);
  const head = git("log", "-1", "--format=%h %ae");
  if (!argv.includes("--push")) return console.log(`COMMITTED wolfproof-review: ${head}, ${what} (not pushed)`), 0;
  const p = spawnSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: ROOT, encoding: "utf8" });
  if (p.status !== 0) return stop(`committed ${head}, push failed: ${p.stderr.trim()}`);
  console.log(`PUSHED wolfproof-review: ${head}, ${what}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
