// The few GitHub API calls the review job makes: earlier inline comments, this run's inline
// comments, and the one summary comment, created once and then edited in place.

import { MARKER } from "./lib.mjs";

function config(env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  const pr = env.PR_NUMBER;
  const token = env.GITHUB_TOKEN;
  if (!repo || !pr || !token) throw new Error("GITHUB_REPOSITORY, PR_NUMBER and GITHUB_TOKEN must be set");
  return { api: env.GITHUB_API_URL || "https://api.github.com", repo, pr, token, bot: env.REVIEW_BOT || "github-actions[bot]" };
}

async function call(c, method, path, body) {
  const res = await fetch(`${c.api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function all(c, path) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await call(c, "GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** Inline comments the review bot has left on this pull request. */
export async function botReviewComments(env) {
  const c = config(env);
  const comments = await all(c, `/repos/${c.repo}/pulls/${c.pr}/comments`);
  return comments.filter((x) => x.user?.login === c.bot);
}

/** Create the summary comment, or edit the one an earlier run left. */
export async function upsertSummary(body, env) {
  const c = config(env);
  const comments = await all(c, `/repos/${c.repo}/issues/${c.pr}/comments`);
  const mine = comments.find((x) => x.user?.login === c.bot && String(x.body || "").startsWith(MARKER));
  if (mine) return call(c, "PATCH", `/repos/${c.repo}/issues/comments/${mine.id}`, { body });
  return call(c, "POST", `/repos/${c.repo}/issues/${c.pr}/comments`, { body });
}
