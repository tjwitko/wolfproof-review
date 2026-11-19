// The deterministic half of wolfproof-review: which of wolfproof's findings sit on lines a change
// touched, the summary comment, and the prompt. No network and no AI here, so all of it is tested.

import { createHash } from "node:crypto";
import path from "node:path";

export const MARKER = "<!-- wolfproof-review:summary -->";
export const GROUPS = ["changed-line", "changed-file", "elsewhere"];
const SUMMARY_LIMIT = 60000; // GitHub rejects a comment body over 65,536 characters.

/**
 * The lines a unified diff adds or changes, per file, on the new side. Run git diff with -U0 so every
 * hunk is exactly the changed lines.
 *
 * Each hunk header's counts say how many body lines follow, and exactly that many are consumed, so a
 * "+++ " or "diff --git " line counts as a header only between hunks. Inside a hunk it is the
 * content of a changed line: an added line reading "++ b/other.py" is "+++ b/other.py" in the diff.
 * @returns {Map<string, {ranges: Array<[number, number]>, deleted: boolean}>}
 */
export function parseDiff(text) {
  const files = new Map();
  let current = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of String(text || "").split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      let body = true;
      if (c === "+" && newLeft > 0) newLeft--;
      else if (c === "-" && oldLeft > 0) oldLeft--;
      else if (c === " " && oldLeft > 0 && newLeft > 0) oldLeft--, newLeft--;
      else if (c !== "\\") {
        // A body shorter than its header promised. git never writes one; credit nothing more to
        // this file, and read the line as a header.
        current = null;
        oldLeft = newLeft = 0;
        body = false;
      }
      // ("\ No newline at end of file" belongs to the line before it.)
      if (body) continue;
    }
    if (line.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      // git ends the header with one tab when the name has a space in it ("+++ b/sp ace.py\t"), and
      // quotes a name that has a tab of its own. Strip only that tab: a space can be part of the name,
      // and "victim.py " is a different file from "victim.py".
      const target = line.slice(4).replace(/\t$/, "");
      if (target === "/dev/null") {
        current = null; // a deleted file has no new lines
        continue;
      }
      const file = unquote(target).replace(/^b\//, "");
      current = files.get(file) || { ranges: [], deleted: false };
      files.set(file, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      const start = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      if (current && newLeft > 0) current.ranges.push([start, start + newLeft - 1]);
    }
  }
  return files;
}

// The escapes git writes in a quoted name (core.quotePath=false still quotes a tab, a newline, a double
// quote, a backslash and other control characters), with \ooo for one byte of the name.
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** A name as git writes it in a "+++ " header, quoted when it has to be: "b/t\tab.py" is b/<tab>ab.py. */
export function unquote(p) {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  // A backslash byte is never part of a multi-byte UTF-8 character, so the escapes can be read from the bytes.
  const src = Buffer.from(p.slice(1, -1), "utf8");
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== 0x5c || i + 1 >= src.length) {
      out.push(src[i]);
      continue;
    }
    const oct = src.subarray(i + 1, i + 4).toString("latin1");
    const next = String.fromCharCode(src[i + 1]);
    if (/^[0-3][0-7]{2}$/.test(oct)) {
      out.push(parseInt(oct, 8));
      i += 3;
    } else if (next in ESCAPES) {
      out.push(ESCAPES[next]);
      i += 1;
    } else out.push(src[i]);
  }
  return Buffer.from(out).toString("utf8");
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

const PATH_CHAR = /[A-Za-z0-9_@+.\/-]/;
const TOKEN = /[A-Za-z0-9_@+.\/-]+(?::\d+(?:-\d+)?)?/g;
const PLAIN_NAME = /^[A-Za-z0-9_@+.\/-]+$/;

// The repository's names a token cannot hold whole (a space, a quote, a letter outside ASCII), longest
// first, found by searching for each name itself. Kept per file set: sortFindings asks once per finding.
const oddNames = new WeakMap();
function oddNamesOf(fileSet) {
  let list = oddNames.get(fileSet);
  if (!list) {
    list = [...fileSet].filter((f) => f && !PLAIN_NAME.test(f)).sort((a, b) => b.length - a.length);
    oddNames.set(fileSet, list);
  }
  return list;
}

/**
 * The repository files a message names, with a line when it gives one. Only names that are files in
 * the repository count, so "0.0.0.0:0" or "node:20-alpine" are never read as locations.
 *
 * Where two names overlap, the longer wins: in "x ace.py:20" the file is "x ace.py", not ace.py, when
 * both exist. A pull request picks its own file names, so one must not be able to move its findings
 * onto an unchanged file by naming itself after part of one. The project's root may lead a name
 * ("/work/p/app.py:3") and counts in its match; the message itself is never rewritten, so a folder
 * that repeats the root's path stays part of the name it is in.
 *
 * A space at either end of a name is also the space between words, so text that fits both "app.py "
 * and app.py names both, and the sort takes the better-placed one. Text that fits only app.py
 * ("(app.py:20)") names only app.py.
 */
export function locationsIn(message, fileSet, root = "") {
  const text = String(message || "");
  const prefix = root ? root.replace(/\/+$/, "") + "/" : "";
  const hits = [];
  // A name at `at`, its lead-in (the root or "./") starting at `start`: its line, and where it ends,
  // or null when a path character runs on into the name from either side.
  const fit = (start, at, name) => {
    if (start > 0 && PATH_CHAR.test(text[start - 1])) return null;
    const lineRef = /^:(\d+)(?:-\d+)?/.exec(text.slice(at + name.length));
    const end = at + name.length + (lineRef ? lineRef[0].length : 0);
    const next = text.slice(end).replace(/^[.,;)]+/, "")[0];
    if (next !== undefined && PATH_CHAR.test(next)) return null;
    return { line: lineRef ? Number(lineRef[1]) : null, end };
  };
  const leadIn = (at) =>
    prefix && text.startsWith(prefix, at - prefix.length) && !(at - prefix.length > 0 && PATH_CHAR.test(text[at - prefix.length - 1]))
      ? at - prefix.length
      : text.startsWith("./", at - 2)
        ? at - 2
        : at;
  // A plain name is one token. Its lead-in is part of the token unless the root has a blank in it.
  const plain = (m, start) => {
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
    if (token && fileSet.has(token)) hits.push({ file: token, line, start, end: m.index + m[0].length, also: [] });
  };
  for (const m of text.matchAll(TOKEN)) plain(m, m.index);
  if (prefix && !PLAIN_NAME.test(prefix)) {
    for (let p = text.indexOf(prefix); p !== -1; p = text.indexOf(prefix, p + 1)) {
      if (p > 0 && PATH_CHAR.test(text[p - 1])) continue;
      const sticky = new RegExp(TOKEN.source, "y");
      sticky.lastIndex = p + prefix.length;
      const m = sticky.exec(text);
      if (m) plain(m, p);
    }
  }
  for (const name of oddNamesOf(fileSet)) {
    // The same name without its space at the start, the end, or both: text that fits this name fits it too.
    const twins = [...new Set([name.trimStart(), name.trimEnd(), name.trim()])].filter((t) => t !== name && fileSet.has(t));
    for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
      const start = leadIn(i);
      const f = fit(start, i, name);
      if (f) hits.push({ file: name, line: f.line, start, end: f.end, also: twins });
    }
  }
  const chosen = [];
  for (const h of hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)) {
    if (!chosen.some((c) => h.start < c.end && c.start < h.end)) chosen.push(h);
  }
  chosen.sort((a, b) => a.start - b.start);
  const found = [];
  chosen.forEach((h, i) => {
    let line = h.line;
    if (line === null) {
      // "Dockerfile builds on ... — line 1 FROM": a line given in words, before the next file named.
      const until = i + 1 < chosen.length ? chosen[i + 1].end : text.length;
      const after = text.slice(h.end, Math.min(until, h.end + 120));
      const words = /\bline (\d+)\b/.exec(after);
      if (words) line = Number(words[1]);
    }
    for (const file of [h.file, ...h.also]) if (!found.some((f) => f.file === file && f.line === line)) found.push({ file, line });
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

/**
 * Text in a code span. A file name is the pull request's to pick: a backtick in it gets a longer fence,
 * and a control character, a newline that would end the list and could close the <details> included,
 * is written as an escape.
 */
export function code(s) {
  const t = String(s).replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  const run = Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length));
  // CommonMark drops one space from each end of a span that has both; a padding space keeps the name's.
  const pad = run || (/^ /.test(t) && / $/.test(t)) ? " " : "";
  const fence = "`".repeat(run + 1);
  return `${fence}${pad}${t}${pad}${fence}`;
}

function where(f, group) {
  const locs = f.locations.filter((l) => l.group === group).map((l) => code(`${l.file}${l.line ? `:${l.line}` : ""}`));
  if (locs.length) return ` — ${locs.slice(0, 6).join(", ")}${locs.length > 6 ? `, +${locs.length - 6} more` : ""}`;
  if (f.related.length) return ` — related: this change edits ${f.related.slice(0, 3).map(code).join(", ")}`;
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
 * @param {{ review?: {status: string, model?: string, posted?: number, offDiff?: Array<{path: string, line: number}>, note?: string, stopped?: string, maxInputTokens?: number} }} extra
 */
export function renderSummary(sorted, { review = { status: "not-run" } } = {}) {
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
  if (m.diffMismatch) {
    out.push("", "> ⚠️ The scan job's diff did not match the pull request's commits, so this review used the diff it computed itself. The pull request's code runs in the scan job and may have changed the scan's files.");
  }

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

  const c = review;
  out.push("", c.model ? `#### Review by \`${escapeMd(c.model)}\`` : "#### The model's review", "");
  if (c.status === "ran") {
    out.push(`${c.posted ?? 0} inline comment(s) on changed lines.`);
  } else if (c.status === "no-key") {
    out.push("Skipped: this repository has no `REVIEW_API_KEY` secret (or `ANTHROPIC_API_KEY`, for the Anthropic provider with no `base-url`). The scanner summary above still runs.");
  } else if (c.status === "fork") out.push("Skipped: a pull request from a fork gets no secrets, so the model did not run.");
  else if (c.status === "no-scan") out.push("Skipped: the scan job left nothing to review. See its log.");
  else if (c.status === "failed" && c.stopped === "input-tokens") {
    out.push(
      `The review stopped at its input-token budget${c.maxInputTokens ? ` of ${c.maxInputTokens} tokens` : ""}, before it finished. ` +
        "The workflow's `max-input-tokens` input sets the budget. See the review job's log."
    );
    if (c.posted) out.push("", `It posted ${c.posted} inline comment(s) before it stopped.`);
  } else if (c.status === "failed") {
    out.push(`The review failed${c.note ? `: ${escapeMd(firstLine(c.note, 300))}` : ""}. See the review job's log.`);
    if (c.posted) out.push("", `It posted ${c.posted} inline comment(s) before it stopped.`);
  } else out.push("Not run.");
  if (c.offDiff?.length) {
    out.push("", `⚠️ ${c.offDiff.length} comment(s) landed on lines this change did not modify: ${c.offDiff.map((o) => code(`${o.path}:${o.line}`)).join(", ")}. Please report this to wolfproof-review.`);
  }
  out.push("", `<sub>[wolfproof-review](https://github.com/tjwitko/wolfproof-review) ${m.reviewVersion || ""} · rules from wolfproof's checks.md</sub>`);

  let body = out.join("\n");
  if (body.length > SUMMARY_LIMIT) body = body.slice(0, SUMMARY_LIMIT) + "\n\n…(cut to fit GitHub's comment limit; the full list is in the job summary)\n";
  return body;
}

// ---- After the review: did any comment land off the diff? -------------------------------------------

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

/**
 * The lines each file gained, from GitHub's own patches (pulls/{pr}/files), for checking the comments
 * against the diff GitHub shows rather than the one this job computed. A patch has context lines, so
 * only its "+" lines count. A file GitHub sent no patch for is listed in `unknown`: its lines cannot be
 * checked.
 * @param {Array<{filename: string, status?: string, patch?: string}>} files
 * @returns {{changed: Map<string, {ranges: Array<[number, number]>}>, unknown: Set<string>}}
 */
export function changedFromPatches(files) {
  const changed = new Map();
  const unknown = new Set();
  for (const f of files || []) {
    if (!f?.filename) continue;
    if (typeof f.patch !== "string") {
      // A rename with no changes has no patch and no lines; anything else without one is unknown.
      if (f.changes === 0) changed.set(f.filename, { ranges: [] });
      else if (f.status !== "removed") unknown.add(f.filename);
      continue;
    }
    const ranges = [];
    let line = 0;
    let inHunk = false;
    for (const l of f.patch.split("\n")) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (h) {
        line = Number(h[1]);
        inHunk = true;
      } else if (!inHunk || l.startsWith("-") || l.startsWith("\\")) {
        continue;
      } else if (l.startsWith("+")) {
        const last = ranges.at(-1);
        if (last && last[1] === line - 1) last[1] = line;
        else ranges.push([line, line]);
        line++;
      } else line++; // a context line
    }
    changed.set(f.filename, { ranges });
  }
  return { changed, unknown };
}

/** Files whose changed lines differ between two parses: this job's diff and GitHub's patches. */
export function diffDisagreement(ours, github, unknown = new Set()) {
  const key = (m, f) => JSON.stringify(m.get(f)?.ranges || []);
  const names = new Set([...ours.keys(), ...github.keys()]);
  return [...names].filter((f) => !unknown.has(f) && key(ours, f) !== key(github, f)).sort();
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
      `- Post each comment with the \`create_inline_comment\` tool: \`path\` relative to the repository root (without the \`${ctx.codeDir}/\` prefix), \`line\` the new-file line number, \`start_line\` only for a range. It accepts only lines the change added or modified.`,
      `- Read files with \`read_file\`, search with \`grep\`, and list files with \`glob\`. Those four tools are all you have.`,
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
  // Only this command's own arguments: up to the next command on the line. As words, the way the
  // shell splits them, so a `;` or a `--base` inside a quoted --title is part of the title.
  const words = shellWords(command.slice(m.index + m[0].length));
  // gh's flags that take a value, so that a value such as `--title -B` is not read as a flag. The
  // last --base wins, as in gh.
  const LONG = /^--(?:assignee|base|body|body-file|head|label|milestone|project|recover|repo|reviewer|template|title)$/;
  const SHORT = "aBbFHlmprRTt";
  let base = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--") break;
    if (w.startsWith("--")) {
      if (w.startsWith("--base=")) base = w.slice("--base=".length);
      else if (LONG.test(w)) {
        const value = words[++i];
        if (w === "--base") base = value ?? null;
      }
    } else if (/^-[A-Za-z]/.test(w)) {
      // Shorthands, which gh lets you run together: -dB develop, -Bdevelop, -B=develop.
      for (let j = 1; j < w.length; j++) {
        if (!SHORT.includes(w[j])) continue;
        const value = j + 1 < w.length ? w.slice(j + 1).replace(/^=/, "") : words[++i];
        if (w[j] === "B") base = value ?? null;
        break;
      }
    }
  }
  return { base: base || null };
}

/** The words of the first command in a shell command line: split on unquoted blanks, with quotes and
 * backslashes removed, up to the first `;`, `&&`, `||`, `|` or newline outside quotes. */
export function shellWords(text) {
  const s = String(text);
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) word += s[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && i + 1 < s.length) {
      if (s[i + 1] !== "\n") word = (word ?? "") + s[i + 1];
      i++;
    } else if (c === ";" || c === "\n" || c === "|" || (c === "&" && s[i + 1] === "&")) {
      break;
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** Whether a review against `reviewed` covers a pull request into `requested`. Both must be named:
 * the hook resolves a pull request with no --base to the repository's default branch first. */
export function sameBase(reviewed, requested) {
  if (!reviewed || !requested) return false;
  const short = (b) => String(b).replace(/^(?:refs\/remotes\/|refs\/heads\/)?(?:origin\/)?/, "");
  return short(reviewed) === short(requested);
}

// ---- Finding wolfproof for a local review (review.mjs local) ----------------------------------

/**
 * How a local review runs wolfproof: the project's own install first, the version the project chose,
 * then WOLFPROOF_BIN. WOLFPROOF_BIN names wolfproof's bin/validate.mjs, its package directory, or a
 * command on PATH such as `wolfproof`. A relative path is taken from `cwd`, the directory the review
 * was started in, and comes back absolute, because wolfproof runs from the repository's top, which can
 * be another directory. `fs` is { exists(p), isDir(p) }, passed in for the tests.
 * @returns {{file: string, args: string[], via: string} | {note: string}}
 *   `file` and `args` for spawnSync, with "." and "--json" still to add; or why it does not run.
 */
export function wolfproofCommand(root, env, fs, node = process.execPath, cwd = process.cwd()) {
  const sep = /[\\/]/;
  const own = `${root}/node_modules/wolfproof/bin/validate.mjs`;
  if (fs.exists(own)) return { file: node, args: [own], via: "this project's node_modules/wolfproof" };
  const bin = String(env.WOLFPROOF_BIN || "").trim();
  if (!bin) {
    return {
      note:
        "wolfproof is not installed in this project (node_modules/wolfproof) and WOLFPROOF_BIN is not set, so there are no " +
        "scanner findings; the review uses the rulebook alone.",
    };
  }
  if (!sep.test(bin)) return { file: bin, args: [], via: `WOLFPROOF_BIN (${bin} on PATH)` };
  const abs = path.resolve(cwd, bin.startsWith("~/") && env.HOME ? `${env.HOME}${bin.slice(1)}` : bin);
  if (!fs.exists(abs)) {
    return { note: `WOLFPROOF_BIN is set to ${bin}, which does not exist, so there are no scanner findings; the review uses the rulebook alone.` };
  }
  if (fs.isDir(abs)) {
    const inside = path.join(abs, "bin", "validate.mjs");
    if (!fs.exists(inside)) {
      return { note: `WOLFPROOF_BIN is set to the directory ${bin}, which has no bin/validate.mjs, so there are no scanner findings; the review uses the rulebook alone.` };
    }
    return { file: node, args: [inside], via: `WOLFPROOF_BIN (${bin})` };
  }
  if (/\.(?:mjs|cjs|js)$/.test(abs)) return { file: node, args: [abs], via: `WOLFPROOF_BIN (${bin})` };
  return { file: abs, args: [], via: `WOLFPROOF_BIN (${bin})` };
}
