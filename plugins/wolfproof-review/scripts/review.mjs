#!/usr/bin/env node
// wolfproof-review's command line, used by the GitHub workflow and the local /wolfproof-review command.
//
//   review.mjs sort     --result F --diff F --files F --out F [--root DIR] [--ignore GLOBS] [--meta F]
//   review.mjs prompt   --agent F --sorted F --diff F --code-dir D --rulebook F --max-comments N
//                       [--existing F] [--mode ci|local] (--out F | --github-output NAME)
//   review.mjs existing --out F                          (GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER)
//   review.mjs check    --diff F --since ISO --out F     (the same variables)
//   review.mjs summary  --sorted F [--claude STATUS] [--check F] [--note TEXT] [--post]
//   review.mjs local    [base] [--no-scan]
//
// Exit 0, or 2 on a usage error. A GitHub call that fails is reported and, for `summary --post`,
// does not fail the step: the job summary still carries the text.

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sortFindings, renderSummary, buildPrompt, offDiff, parseDiff, localDirName, STAMP } from "./lib.mjs";
import { botReviewComments, upsertSummary } from "./github.mjs";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LARGE_CHANGE = 1500;

function opts(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) o._.push(a);
    else if (a.includes("=")) o[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) o[a.slice(2)] = argv[++i];
    else o[a.slice(2)] = true;
  }
  return o;
}

function need(o, ...names) {
  const missing = names.filter((n) => o[n] === undefined || o[n] === true);
  if (missing.length) {
    console.error(`wolfproof-review: missing ${missing.map((n) => `--${n}`).join(", ")}`);
    process.exit(2);
  }
}

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const readText = (f) => (f && existsSync(f) ? readFileSync(f, "utf8") : "");
const lines = (s) => String(s).split("\n").map((l) => l.trim()).filter(Boolean);

function sort(o) {
  need(o, "diff", "files", "out");
  const sorted = sortFindings({
    result: o.result ? readJson(o.result) : null,
    diff: readText(o.diff),
    files: lines(readText(o.files)),
    root: o.root || "",
    ignore: typeof o.ignore === "string" ? lines(o.ignore.replace(/,/g, "\n")) : [],
    meta: o.meta ? readJson(o.meta) || {} : {},
  });
  writeFileSync(o.out, JSON.stringify(sorted, null, 2));
  const c = sorted.counts;
  console.log(`sorted: ${c["changed-line"]} on changed lines, ${c["changed-file"]} in changed files, ${c.elsewhere} elsewhere${c.ignored ? `, ${c.ignored} ignored` : ""}`);
}

function prompt(o) {
  need(o, "agent", "sorted", "diff", "code-dir", "rulebook", "max-comments");
  const sorted = readJson(o.sorted) || { change: { lines: 0 } };
  const text = buildPrompt(readFileSync(o.agent, "utf8"), {
    mode: o.mode === "local" ? "local" : "ci",
    codeDir: o["code-dir"],
    diffPath: o.diff,
    sortedPath: o.sorted,
    rulebookPath: o.rulebook,
    existingPath: o.existing || null,
    maxComments: Number(o["max-comments"]),
    changedLines: sorted.change?.lines || 0,
    largeChange: LARGE_CHANGE,
  });
  if (o.out) writeFileSync(o.out, text);
  if (o["github-output"]) {
    const delimiter = `EOF_${randomBytes(12).toString("hex")}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `${o["github-output"]}<<${delimiter}\n${text}\n${delimiter}\n`);
  }
}

async function existing(o) {
  need(o, "out");
  let list = [];
  try {
    list = (await botReviewComments()).map((c) => ({ path: c.path, line: c.line ?? c.original_line, body: String(c.body || "").slice(0, 400) }));
  } catch (err) {
    console.error(`wolfproof-review: could not list earlier comments (${err.message}); continuing without them`);
  }
  writeFileSync(o.out, JSON.stringify(list, null, 2));
  console.log(`${list.length} earlier inline comment(s)`);
}

async function check(o) {
  need(o, "diff", "since", "out");
  const since = Date.parse(o.since);
  let result = { posted: 0, offDiff: [], error: null };
  try {
    const mine = (await botReviewComments()).filter((c) => Date.parse(c.created_at) >= since);
    result = { posted: mine.length, offDiff: offDiff(mine, parseDiff(readText(o.diff))), error: null };
  } catch (err) {
    result.error = err.message;
  }
  writeFileSync(o.out, JSON.stringify(result, null, 2));
  console.log(`${result.posted} comment(s) this run, ${result.offDiff.length} off the diff${result.error ? ` (error: ${result.error})` : ""}`);
  for (const x of result.offDiff) console.log(`::warning::wolfproof-review commented off the diff at ${x.path}:${x.line}`);
}

async function summary(o) {
  need(o, "sorted");
  const sorted = readJson(o.sorted) || { meta: {}, scan: { ran: false }, change: { files: 0, lines: 0 }, findings: [], counts: {} };
  const checked = o.check ? readJson(o.check) : null;
  const claude = { status: typeof o.claude === "string" ? o.claude : "not-run", posted: checked?.posted, offDiff: checked?.offDiff, note: typeof o.note === "string" ? o.note : undefined };
  const body = renderSummary(sorted, { claude });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body.replace(/^<!--.*-->\n/, "") + "\n");
  else process.stdout.write(body + "\n");
  if (o.post) {
    try {
      await upsertSummary(body);
      console.log("summary comment posted");
    } catch (err) {
      // A fork's pull request has a read-only token: the job summary is all it gets.
      console.log(`::notice::wolfproof-review could not post the summary comment (${err.status || ""} ${err.message.split(":")[0]}); it is in the job summary`);
    }
  }
}

// ---- Local use, from the /wolfproof-review command --------------------------------------------

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function defaultBase(cwd) {
  try {
    return git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd).trim();
  } catch {
    for (const b of ["main", "master", "origin/main", "origin/master"]) {
      try {
        git(["rev-parse", "--verify", "--quiet", b], cwd);
        return b;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function local(o) {
  const cwd = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const base = o._[1] || defaultBase(cwd);
  if (!base) {
    console.error("wolfproof-review: no base branch given and none found (tried origin/HEAD, main, master)");
    process.exit(2);
  }
  const mergeBase = git(["merge-base", base, "HEAD"], cwd).trim();
  // The pull-request hook (pr-hook.mjs) reads meta.json here to tell whether HEAD has been reviewed.
  const dir = path.join(os.tmpdir(), localDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);

  // The working tree against the merge base: committed and uncommitted changes to tracked files.
  writeFileSync(f("diff.patch"), git(["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-U0", "-M", mergeBase], cwd));
  writeFileSync(f("files.txt"), git(["-c", "core.quotePath=false", "ls-files"], cwd));

  let resultFile = null;
  let scanNote = "";
  const gate = path.join(cwd, "node_modules", "wolfproof", "bin", "validate.mjs");
  if (o["no-scan"]) scanNote = "Scan skipped (--no-scan).";
  else if (!existsSync(gate)) scanNote = "wolfproof is not installed in this project (node_modules/wolfproof), so there are no scanner findings; the review uses the rulebook alone.";
  else {
    // The gate runs the project's tests and builds, as it always does.
    const r = spawnSync(process.execPath, [gate, ".", "--json"], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000 });
    if (r.stdout && r.stdout.trim().startsWith("{")) {
      writeFileSync(f("result.json"), r.stdout);
      resultFile = f("result.json");
    } else scanNote = `wolfproof did not produce a result (exit ${r.status}${r.error ? `, ${r.error.code}` : ""}).`;
  }
  const head = git(["rev-parse", "HEAD"], cwd).trim();
  writeFileSync(f("meta.json"), JSON.stringify({ head, base, mergeBase, scanNote, mode: "local" }));
  // What the pull-request hook (pr-hook.mjs) checks: which commit was reviewed, against which base.
  // In the repository's own git directory, which the hook finds whatever temporary directory it sees.
  try {
    writeFileSync(path.join(git(["rev-parse", "--absolute-git-dir"], cwd).trim(), STAMP), JSON.stringify({ head, base }) + "\n");
  } catch (err) {
    console.log(`note: could not record this review for the pull-request hook (${err.code || err.message}).`);
  }
  sort({ result: resultFile, diff: f("diff.patch"), files: f("files.txt"), root: cwd, out: f("sorted.json"), meta: f("meta.json") });
  prompt({
    agent: path.join(PLUGIN, "agents", "wolfproof-reviewer.md"),
    sorted: f("sorted.json"),
    diff: f("diff.patch"),
    "code-dir": cwd,
    rulebook: path.join(PLUGIN, "rulebook", "checks.md"),
    "max-comments": o["max-comments"] || 15,
    mode: "local",
    out: f("prompt.md"),
  });
  if (scanNote) console.log(scanNote);
  console.log(`base: ${base} (merge base ${mergeBase.slice(0, 7)})`);
  console.log(`instructions: ${f("prompt.md")}`);
}

const o = opts(process.argv.slice(2));
const commands = { sort, prompt, existing, check, summary, local };
const run = commands[o._[0]];
if (!run) {
  console.error(`usage: review.mjs <${Object.keys(commands).join("|")}> ...`);
  process.exit(2);
}
await run(o);
