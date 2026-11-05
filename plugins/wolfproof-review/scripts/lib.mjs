// The deterministic half of wolfproof-review: which of wolfproof's findings sit on lines a change
// touched, the summary comment, and the prompt. No network and no AI here, so all of it is tested.

import { createHash } from "node:crypto";

export const MARKER = "<!-- wolfproof-review:summary -->";
export const GROUPS = ["changed-line", "changed-file", "elsewhere"];
const SUMMARY_LIMIT = 60000; // GitHub rejects a comment body over 65,536 characters.

/**
 * The lines a unified diff adds or changes, per file, on the new side. Run git diff with -U0 so every
 * hunk is exactly the changed lines.
 * @returns {Map<string, {ranges: Array<[number, number]>, deleted: boolean}>}
 */
export function parseDiff(text) {
  const files = new Map();
  let current = null;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = null; // a deleted file has no new lines
        continue;
      }
      const file = unquote(target).replace(/^b\//, "");
      current = files.get(file) || { ranges: [], deleted: false };
      files.set(file, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) current.ranges.push([start, start + count - 1]);
    }
  }
  return files;
}

function unquote(p) {
  // git quotes a path with unusual characters: "b/caf\303\251.js". Good enough to match plain names;
  // a quoted one simply matches nothing, which puts its findings in "elsewhere", never on a line.
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

export function onChangedLine(changed, file, line) {
  const f = changed.get(file);
  return Boolean(f && line && f.ranges.some(([a, b]) => line >= a && line <= b));
}

/** A glob (`*`, `**`, `?`) as a regular expression over a repository-relative path. */
export function globToRegExp(glob) {
  let re = "";
  const g = glob.trim().replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += g[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern naming a directory covers what is under it.
  return new RegExp(`^${re}(?:/.*)?$`);
}

export function ignoredBy(patterns) {
  const res = (patterns || []).filter((p) => p.trim()).map(globToRegExp);
  return (file) => res.some((r) => r.test(file));
}

/** The check a message comes from: wolfproof starts each one with it, as in "sast: SQL injection ...". */
export function checkOf(message) {
  const m = /^([a-z][a-z0-9_ ()./-]{0,40}?):\s/i.exec(String(message || ""));
  return m ? m[1] : "other";
}

const TOKEN = /[A-Za-z0-9_@+.\/-]+(?::\d+(?:-\d+)?)?/g;

/**
 * The repository files a message names, with a line when it gives one. Only names that are files in
 * the repository count, so "0.0.0.0:0" or "node:20-alpine" are never read as locations.
 */
export function locationsIn(message, fileSet, root = "") {
  const text = String(message || "");
  const prefix = root ? root.replace(/\/+$/, "") + "/" : "";
  const found = [];
  const hits = [];
  for (const m of text.matchAll(TOKEN)) {
    let token = m[0].replace(/[.,;)]+$/, "");
    let line = null;
    const withLine = /^(.*?):(\d+)(?:-\d+)?$/.exec(token);
    if (withLine) {
      token = withLine[1];
      line = Number(withLine[2]);
    }
    token = token.replace(/:+$/, "");
    if (prefix && token.startsWith(prefix)) token = token.slice(prefix.length);
    token = token.replace(/^\.\//, "");
    if (!token || !fileSet.has(token)) continue;
    hits.push({ file: token, line, end: m.index + m[0].length });
  }
  hits.forEach((h, i) => {
    let line = h.line;
    if (line === null) {
      // "Dockerfile builds on ... — line 1 FROM": a line given in words, before the next file named.
      const until = i + 1 < hits.length ? hits[i + 1].end : text.length;
      const after = text.slice(h.end, Math.min(until, h.end + 120));
      const words = /\bline (\d+)\b/.exec(after);
      if (words) line = Number(words[1]);
    }
    if (!found.some((f) => f.file === h.file && f.line === line)) found.push({ file: h.file, line });
  });
  // A file named once with a line and once without: the line says more.
  return found.filter((f) => f.line !== null || !found.some((g) => g.file === f.file && g.line !== null));
}

// Checks whose findings name no file but are about files of a known kind, so a change to such a file
// is related to the finding: a dependency finding when the change edits package.json, say.
const RELATED = [
  {
    check: /^(check_dependencies|dependencies|dep-audit)/,
    file: /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|uv\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|gradle\.lockfile|[^/]+\.csproj|packages\.lock\.json)$/,
  },
  { check: /^(dockerfile|trivy)/, file: /(^|\/)([^/]*\.)?Dockerfile(\.[^/]+)?$|\.dockerfile$/i },
  { check: /^(retention|immutability|iam|checkov \(terraform\)|terraform|infrastructure)/, file: /\.tf$/ },
];

function relatedFiles(check, changedFiles) {
  const rule = RELATED.find((r) => r.check.test(check));
  return rule ? changedFiles.filter((f) => rule.file.test(f)) : [];
}

const rank = (g) => GROUPS.indexOf(g);

/**
 * Sort wolfproof's findings by where they are relative to the change.
 * @param {{ result: object|null, diff: string, files: string[], root?: string, ignore?: string[], meta?: object }} input
 */
export function sortFindings({ result, diff, files, root = "", ignore = [], meta = {} }) {
  const isIgnored = ignoredBy(ignore);
  const changed = parseDiff(diff);
  for (const f of [...changed.keys()]) if (isIgnored(f)) changed.delete(f);
  const fileSet = new Set(files);
  const changedFiles = [...changed.keys()];
  const changedLines = [...changed.values()].reduce((n, f) => n + f.ranges.reduce((m, [a, b]) => m + b - a + 1, 0), 0);

  const out = {
    meta,
    scan: result
      ? {
          ran: true,
          exitCode: result.exitCode ?? null,
          outcome: result.exitCode === 0 ? "clean" : result.exitCode === 1 ? "blocked" : "incomplete",
          blocking: result.blocking ?? null,
          couldNotRun: (result.couldNotRun || []).map(String),
          error: result.error || null,
        }
      : { ran: false },
    change: { files: changedFiles.length, lines: changedLines, changedFiles },
    findings: [],
    counts: { "changed-line": 0, "changed-file": 0, elsewhere: 0, ignored: 0 },
  };
  if (!result) return out;

  const entries = [
    ...(result.findings || []).map((f) => ({ ...f, severity: f.severity || "blocking" })),
    ...(result.advisories || []).map((f) => ({ ...f, severity: f.severity || "advisory" })),
  ];
  for (const entry of entries) {
    const message = String(entry.message || "");
    const check = checkOf(message);
    const all = locationsIn(message, fileSet, root || result.project || "");
    const locations = all
      .filter((l) => !isIgnored(l.file))
      .map((l) => ({
        ...l,
        group: onChangedLine(changed, l.file, l.line) ? "changed-line" : changed.has(l.file) ? "changed-file" : "elsewhere",
      }));
    if (all.length && !locations.length) {
      out.counts.ignored++;
      continue;
    }
    let group = locations.length ? locations.map((l) => l.group).sort((a, b) => rank(a) - rank(b))[0] : "elsewhere";
    let related = [];
    if (!locations.length) {
      related = relatedFiles(check, changedFiles);
      if (related.length) group = "changed-file";
    }
    out.counts[group]++;
    out.findings.push({ check, severity: entry.severity, group, message, locations, related });
  }
  out.findings.sort((a, b) => rank(a.group) - rank(b.group) || (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1));
  return out;
}

// ---- The summary comment ------------------------------------------------------------------------

function firstLine(message, max = 320) {
  const one = String(message).split("\n")[0].trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function where(f, group) {
  const locs = f.locations.filter((l) => l.group === group).map((l) => `\`${l.file}${l.line ? `:${l.line}` : ""}\``);
  if (locs.length) return ` — ${locs.slice(0, 6).join(", ")}${locs.length > 6 ? `, +${locs.length - 6} more` : ""}`;
  if (f.related.length) return ` — related: this change edits ${f.related.slice(0, 3).map((r) => `\`${r}\``).join(", ")}`;
  return "";
}

function escapeMd(s) {
  // Messages are wolfproof's text about the project, which can quote the project. Keep it from
  // closing the <details> block or pinging anyone.
  return String(s).replace(/</g, "&lt;").replace(/@(?=[A-Za-z0-9-])/g, "@​");
}

/**
 * The one summary comment, rewritten on each push.
 * @param {object} sorted sortFindings' output
 * @param {{ claude?: {status: string, posted?: number, offDiff?: Array<{path: string, line: number}>, note?: string} }} extra
 */
export function renderSummary(sorted, { claude = { status: "not-run" } } = {}) {
  const m = sorted.meta || {};
  const head = m.head ? ` \`${String(m.head).slice(0, 7)}\`` : "";
  const out = [MARKER, "### wolfproof review", ""];
  if (!sorted.scan.ran) {
    out.push(`wolfproof did not produce a result for${head || " this change"}, so there are no scanner findings below. ${m.scanNote || "See the scan job's log."}`);
  } else {
    const s = sorted.scan;
    out.push(
      `wolfproof ${m.wolfproof || ""} scanned${head}: **${s.outcome}** for the whole repository (${s.blocking ?? "?"} blocking). ` +
        `This review is comment-only and does not fail the build.`
    );
    if (s.error) out.push("", `> wolfproof stopped early: ${escapeMd(firstLine(s.error, 300))}`);
    if (s.couldNotRun.length) out.push("", `> Not checked on this runner: ${escapeMd(s.couldNotRun.map((c) => firstLine(c, 160)).join("; "))}`);
  }
  out.push("", `The change: ${sorted.change.lines} line(s) added or modified in ${sorted.change.files} file(s).`);

  const section = (group, title, open) => {
    const list = sorted.findings.filter((f) => f.group === group && (group !== "elsewhere" || f.severity === "blocking"));
    if (!list.length) return;
    const text = (f) => (f.message.startsWith(`${f.check}: `) ? f.message.slice(f.check.length + 2) : f.message);
    const lines = list.map((f) => `- ${f.severity === "blocking" ? "**blocking**" : "advisory"} · **${escapeMd(f.check)}**: ${escapeMd(firstLine(text(f)))}${where(f, group)}`);
    if (open) out.push("", `#### ${title} (${list.length})`, "", ...lines);
    else out.push("", `<details><summary>${title} (${list.length})</summary>`, "", ...lines, "", "</details>");
  };
  section("changed-line", "On lines this change added or modified", true);
  section("changed-file", "In files this change touched, not on changed lines", true);
  section("elsewhere", "Already in the repository, untouched by this change (blocking findings only)", false);
  const quiet = sorted.findings.filter((f) => f.group === "elsewhere" && f.severity !== "blocking").length;
  if (sorted.scan.ran && !sorted.findings.some((f) => f.group !== "elsewhere")) {
    out.push("", "No scanner finding is on a line or file this change touched.");
  }
  if (quiet || sorted.counts.ignored) {
    out.push("", `<sub>${quiet} advisory note(s) elsewhere in the repository not listed${sorted.counts.ignored ? `; ${sorted.counts.ignored} finding(s) in ignored paths` : ""}.</sub>`);
  }

  out.push("", "#### Claude's review", "");
  const c = claude;
  if (c.status === "ran") {
    out.push(`${c.posted ?? 0} inline comment(s) on changed lines.`);
    if (c.offDiff?.length) {
      out.push("", `⚠️ ${c.offDiff.length} comment(s) landed on lines this change did not modify: ${c.offDiff.map((o) => `\`${o.path}:${o.line}\``).join(", ")}. Please report this to wolfproof-review.`);
    }
  } else if (c.status === "no-key") out.push("Skipped: this repository has no `ANTHROPIC_API_KEY` secret. The scanner summary above still runs.");
  else if (c.status === "fork") out.push("Skipped: a pull request from a fork gets no secrets, so Claude did not run.");
  else if (c.status === "no-scan") out.push("Skipped: the scan job left nothing to review. See its log.");
  else if (c.status === "failed") out.push(`Claude's step failed${c.note ? `: ${escapeMd(c.note)}` : ""}. See the review job's log.`);
  else out.push("Not run.");
  out.push("", `<sub>[wolfproof-review](https://github.com/tjwitko/wolfproof-review) ${m.reviewVersion || ""} · rules from wolfproof's checks.md</sub>`);

  let body = out.join("\n");
  if (body.length > SUMMARY_LIMIT) body = body.slice(0, SUMMARY_LIMIT) + "\n\n…(cut to fit GitHub's comment limit; the full list is in the job summary)\n";
  return body;
}

// ---- After Claude: did any comment land off the diff? -------------------------------------------

/** Review comments, as GitHub's API returns them, on lines the change did not add or modify. */
export function offDiff(comments, changed) {
  return comments
    .filter((c) => {
      const line = c.line ?? c.original_line;
      const start = c.start_line ?? line;
      if (!line) return true;
      for (let l = start; l <= line; l++) if (!onChangedLine(changed, c.path, l)) return true;
      return false;
    })
    .map((c) => ({ path: c.path, line: c.line ?? c.original_line ?? null }));
}

// ---- The prompt ---------------------------------------------------------------------------------

export function stripFrontMatter(md) {
  return String(md).replace(/^---\n[\s\S]*?\n---\n+/, "");
}

/**
 * The reviewer's instructions, with this run's paths and limits after them.
 * @param {string} agentMd the agent file, front matter included
 */
export function buildPrompt(agentMd, ctx) {
  const lines = [
    stripFrontMatter(agentMd).trim(),
    "",
    "## This run",
    "",
    `- Mode: ${ctx.mode === "local" ? "local — print the review in your reply" : "GitHub pull request — post inline comments"}.`,
    `- The code at the change's head: \`${ctx.codeDir}\`. Read files there.`,
    `- The diff (zero lines of context): \`${ctx.diffPath}\`.`,
    `- The sorted findings: \`${ctx.sortedPath}\`.`,
    `- The rulebook: \`${ctx.rulebookPath}\`.`,
  ];
  if (ctx.existingPath) lines.push(`- Inline comments already on this pull request, from earlier runs: \`${ctx.existingPath}\`. Do not repeat one.`);
  lines.push(`- At most ${ctx.maxComments} comments.`);
  if (ctx.mode !== "local") {
    lines.push(
      `- Post each comment with \`mcp__github_inline_comment__create_inline_comment\`: \`path\` relative to the repository root (without the \`${ctx.codeDir}/\` prefix), \`line\` the new-file line number, \`side\` "RIGHT", \`confirmed\` true.`,
      `- Nothing else you write is shown to anyone. Finish with one line: how many comments you posted.`
    );
  }
  if (ctx.changedLines > ctx.largeChange) {
    lines.push(`- This change is large (${ctx.changedLines} changed lines). Start with the files that have findings, then the files that handle requests, credentials, queries, commands or file paths.`);
  }
  return lines.join("\n") + "\n";
}

// ---- The pull-request hook (scripts/pr-hook.mjs) ----------------------------------------------

/** The file in a repository's git directory that records the last local review: { head, base }. */
export const STAMP = "wolfproof-review.json";

/** The directory, under the system's temporary directory, where a local review of this repository
 * keeps its inputs. One per repository, named by a hash of its root. */
export function localDirName(repoRoot) {
  return `wolfproof-review-${createHash("sha256").update(repoRoot).digest("hex").slice(0, 12)}`;
}

/**
 * Whether a shell command opens a pull request with `gh pr create` (or its alias `gh pr new`), and the
 * base it names with --base or -B. null when it does not open one.
 * @returns {{base: string|null}|null}
 */
export function prCreate(command) {
  const m = /(?:^|[\s;&|(`])gh\s+pr\s+(?:create|new)(?=\s|$|[;&|)`])/.exec(String(command));
  if (!m) return null;
  // Only this command's own arguments: up to the next command on the line.
  const rest = command.slice(m.index + m[0].length).split(/&&|\|\||[;\n|]/)[0];
  const b = /(?:^|\s)(?:--base|-B)(?:=|\s+)("[^"]*"|'[^']*'|[^\s"']+)/.exec(rest);
  return { base: b ? b[1].replace(/^["']|["']$/g, "") : null };
}

/** Whether a review against `reviewed` covers a pull request into `requested`. A pull request that
 * names no base goes to the default branch, which is what a review with no base uses too. */
export function sameBase(reviewed, requested) {
  if (!requested) return true;
  const short = (b) => String(b || "").replace(/^(?:refs\/remotes\/|refs\/heads\/)?(?:origin\/)?/, "");
  return short(reviewed) === short(requested);
}
