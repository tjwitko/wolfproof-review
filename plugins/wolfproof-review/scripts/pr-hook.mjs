#!/usr/bin/env node
// A PreToolUse hook (hooks/hooks.json): before Claude opens a pull request with `gh pr create`, it
// checks that /wolfproof-review has reviewed the commit being proposed. If not, the call is denied with
// instructions to run the review first; Claude runs it and tries again.
//
// "Reviewed" means `review.mjs local` prepared a review of the current HEAD, against the base the pull
// request names (meta.json in the review's directory). A new commit needs a new review.
//
// A pull request that names no --base goes to the repository's default branch: origin/HEAD, or what
// `gh repo view` says. When neither tells, the call is denied, with a request to name --base.
//
// This is a nudge for Claude, not a control. It lets the call through when it cannot read the hook's
// input or the command is not run in a git repository with a commit, and WOLFPROOF_REVIEW_HOOK=off in
// Claude Code's environment turns it off. A review record it cannot read counts as no review, so the
// call is denied. The GitHub workflow is the review that runs on every pull request regardless.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STAMP, localDirName, prCreate, sameBase } from "./lib.mjs";

const REVIEW = path.join(path.dirname(fileURLToPath(import.meta.url)), "review.mjs");

/** The decision for one hook input: null to let the call through, or the reason to deny it. */
export function decide(input, { env = process.env, tmp = os.tmpdir() } = {}) {
  if (env.WOLFPROOF_REVIEW_HOOK === "off") return null;
  if (input?.tool_name !== "Bash") return null;
  const pr = prCreate(input.tool_input?.command || "");
  if (!pr) return null;

  const git = (...args) => execFileSync("git", args, { cwd: input.cwd || process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let root, gitDir, head;
  try {
    root = git("rev-parse", "--show-toplevel");
    gitDir = git("rev-parse", "--absolute-git-dir");
    head = git("rev-parse", "HEAD");
  } catch {
    return null; // Not a repository, or no commit yet: gh will say so itself.
  }
  // The stamp in the git directory, or the review's own record under the temporary directory, which
  // is the same one only when this hook and Claude's shell see the same TMPDIR.
  const read = (file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  const records = [read(path.join(gitDir, STAMP)), read(path.join(tmp, localDirName(root), "meta.json"))].filter(Boolean);
  const target = pr.base || defaultBranch(git, input.cwd || process.cwd(), env);
  if (!target) {
    return (
      `Not opening the pull request yet: it names no --base, and the hook could not find this repository's ` +
      `default branch (no origin/HEAD, and \`gh repo view\` did not say), so it cannot tell whether the review ` +
      `covers it. Run the same gh pr create command again with --base <branch>, after reviewing against that ` +
      `branch if you have not.`
    );
  }
  if (records.some((m) => m.head === head && sameBase(m.base, target))) return null;
  const meta = records.find((m) => m.head === head) || records[0] || null;

  const why = !meta
    ? `this repository's commit ${head.slice(0, 7)} has not been reviewed with wolfproof-review`
    : meta.head !== head
      ? `the last wolfproof review was of commit ${String(meta.head).slice(0, 7)}, and HEAD is now ${head.slice(0, 7)}`
      : `the last wolfproof review was against ${meta.base}, and this pull request goes to ${target}` +
        `${pr.base ? "" : " (the default branch, since it names no --base)"}`;
  return (
    `Not opening the pull request yet: ${why}. Review it first: run the /wolfproof-review command` +
    ` with the argument ${target}, or prepare it directly with ` +
    `\`node "${REVIEW}" local ${target}\` (Bash timeout 900000 ms; when wolfproof is installed it runs the ` +
    `project's tests and build) and then read and follow the instructions file it names. Fix what the review ` +
    `finds or tell the user about it, then run the same gh pr create command again. A new commit needs a new review.`
  );
}

/** The repository's default branch, which is where `gh pr create` without --base opens the pull
 * request: origin/HEAD, else `gh repo view`. null when neither says. */
function defaultBranch(git, cwd, env) {
  try {
    return git("symbolic-ref", "--short", "refs/remotes/origin/HEAD") || null; // "origin/main"
  } catch {
    /* not set in this clone; ask gh */
  }
  try {
    const name = execFileSync("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    }).trim();
    return name || null;
  } catch {
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = null;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // An input this cannot read: let the call through.
  }
  const reason = decide(input);
  if (reason) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n");
  }
  process.exit(0);
}
