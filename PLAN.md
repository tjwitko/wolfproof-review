# wolfproof-review: plan

A pull-request reviewer for legacy repositories. Wolfproof's scanners supply the evidence, wolfproof's
rules are the guideline, and Claude comments on the lines the pull request changed. By default it
never fails the build, so a repository with years of findings can adopt it on day one.

Status: plan only. Nothing here is built yet.

## How it differs from the wolfproof gate

| | wolfproof gate | wolfproof-review |
|---|---|---|
| Judges | the whole repository | the lines this pull request changed |
| Existing findings | block | listed once, in a summary, never blocking |
| Result | clean / blocked / incomplete, fails the build | comments; fails the build only if a team opts in (phase 3) |
| Who decides | deterministic checks only | the checks, then Claude reading the code |
| Repository | `tjwitko/wolfproof` | `tjwitko/wolfproof-review` (new) |

The gate is unchanged. A team that outgrows the reviewer turns the gate on.

## How it works

Two jobs, so the job that runs the project's code never holds the API key.

1. **scan** — no secrets, `contents: read` only.
   - Checks out the pull request with `persist-credentials: false`.
   - Runs `tjwitko/wolfproof/.github/actions/control-tooling` and `tjwitko/wolfproof`, with
     `continue-on-error: true`, at the pinned version (v1.15.0 to start). No task file: it is optional,
     and a legacy repository has none. CodeQL stays off (its licence; see wolfproof's `docs/checks.md`).
   - Writes the diff against the base branch, with changed line ranges per file.
   - Uploads both, the gate's JSON (the Action's `result` output) and the diff, as an artifact.
   This job runs the project's tests and builds, as the gate always does. That is why it has no key.

2. **review** — `ANTHROPIC_API_KEY`, `contents: read`, `pull-requests: write`. Runs no project code.
   - Downloads the artifact.
   - `scripts/sort-findings.mjs` sorts every finding into three groups: **on a changed line**, **in a
     changed file**, and **already there**. Deterministic, no AI.
   - `scripts/summary.mjs` posts one summary comment from that sort, updated in place on each push:
     counts by check, the changed-line findings in full, the rest collapsed.
   - `anthropics/claude-code-action` (v1, pinned by SHA) runs the `wolfproof-reviewer` agent from this
     repository's plugin. Claude gets the sorted findings, the diff and the rulebook, and posts inline
     comments with `mcp__github_inline_comment__create_inline_comment`.

**Claude can add to the scanners' findings but cannot remove them.** The summary is written by a
script, so a pull request that talks Claude out of a finding (prompt injection in a comment or a
string) still has that finding in the summary.

## What Claude is told

The agent prompt lives once, in `plugins/wolfproof-review/agents/wolfproof-reviewer.md`. The GitHub
job and local use both load it. The rules it gives Claude:

- **Changed lines only.** Inline comments go on lines this pull request added or changed. Issues
  elsewhere are left to the summary.
- **Read before repeating.** For each scanner finding on a changed line, read the code and say whether
  it holds. Wolfproof has false positives (`docs/candidate-rules.md` records them), and "the scanner
  says" without reading is noise.
- **Name the rule.** Each comment names the wolfproof check it comes from, from the rulebook, says what
  goes wrong and suggests a fix.
- **Same rules, missed by the scanners.** Claude may flag something in the changed code that a rulebook
  check describes but no scanner reported. Those comments say "not from a scanner", so readers can
  weigh them differently.
- **No style, no praise, no approval.** Security and correctness only, as the rulebook defines them.
  Never approve or request changes.
- **A ceiling.** At most 15 inline comments per run, most serious first (a starting value to tune in
  phase 2).

**The rulebook** is wolfproof's `docs/checks.md` at the pinned version, copied into the plugin as
`rulebook/checks.md`. Wolfproof's npm install does not include `docs/`, so the copy is needed. A CI test
fails if it differs from the file at the pinned tag.

## Repository layout

```text
wolfproof-review/
  .claude-plugin/marketplace.json          lists the one plugin, source "./plugins/wolfproof-review"
  plugins/wolfproof-review/
    .claude-plugin/plugin.json
    agents/wolfproof-reviewer.md           the prompt, the only copy
    commands/wolfproof-review.md           local use: /wolfproof-review [base-branch]
    rulebook/checks.md                     wolfproof's docs/checks.md at the pinned tag
  .github/workflows/review.yml             the reusable workflow teams call (on: workflow_call)
  .github/workflows/ci.yml                 tests, rulebook check, a smoke review on a fixture PR
  scripts/sort-findings.mjs
  scripts/summary.mjs
  test/
  README.md
```

## What a team adds

One file and one secret, `ANTHROPIC_API_KEY`:

```yaml
# .github/workflows/wolfproof-review.yml
name: wolfproof review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    uses: tjwitko/wolfproof-review/.github/workflows/review.yml@v1
    secrets:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Inputs, all optional: `model` (default Sonnet 5.5, `claude-sonnet-5-5`), `max-comments`, `paths-ignore`,
and later `fail-on: new-blocking` (phase 3).

For local use: `/plugin marketplace add tjwitko/wolfproof-review`, then install `wolfproof-review`,
then `/wolfproof-review main`. If wolfproof is installed in the project, the command runs it by path
(`node node_modules/wolfproof/bin/validate.mjs . --json`, never `npx`); otherwise it reviews without
scanner evidence and says so at the top.

## Security

- **The key stays out of the job that runs code.** See the two jobs above.
- **No forks.** A fork's pull request gets no secrets under `pull_request`, so the review job skips
  with a notice. The workflow never uses `pull_request_target`, which would hand fork code the key.
- **Claude's tools are limited:** read, grep, the inline-comment tool. No shell, no network, no file
  writes. With no shell, a prompt injection has nothing to run.
- **Everything is pinned:** wolfproof by tag, `claude-code-action` and every other action by SHA. The
  plugin version is pinned in the workflow, and Dependabot proposes updates.

## Phases

Each phase ends when its exit test passes, not on a date.

**Phase 1: the reviewer, dogfooded.** Both jobs, both scripts, the agent, the reusable workflow. Matching
findings to the diff reads `file:line` out of the gate's messages and the file in sast, authentication
and CodeQL IDs. It is approximate, which is acceptable while nothing blocks.
*Exit:* it runs on every pull request of one legacy repository for two weeks, with zero inline
comments on unchanged lines.

**Phase 2: measured and tuned.** The measurements below, then prompt and ceiling changes until they
hold.
*Exit:* the targets below on two legacy repositories.

**Phase 3: exact matching, after wolfproof #36.** Once the gate's JSON gives every finding an ID and a
file and line, and a project can snapshot its existing findings, `sort-findings.mjs` uses those instead
of reading messages. Then, and not before, the opt-in `fail-on: new-blocking`: fail only on a blocking
finding that is not in the snapshot. In factory mode #36 refuses snapshot entries a change added
itself, and the reviewer relies on that.
*Exit:* the ID-stability count from #36 is zero on both repositories.

**Phase 4: published.** README, a `v1` tag, the plugin in the marketplace file. Announced to other
teams.

## Measuring it

Each case runs three times. Results vary between runs of the same model, so one run proves little.

- **Zero comments off the diff (deterministic).** A script checks every inline comment's line against
  the diff. Any miss fails CI.
- **No scanner finding dropped (deterministic).** Every finding the sort put on a changed line appears
  in the summary.
- **Recall on known defects.** Pull requests that add the defects behind wolfproof's corpus fixtures
  (the webhook series, whose verdicts are known) to a legacy repository. Target, to revisit: at least
  8 in 10 flagged, inline, on the right line.
- **Noise on real history.** Replay 20 merged pull requests from each legacy repository, and have a
  person mark each comment useful or not. Targets, to revisit: at least 7 in 10 useful, and a median
  of 3 or fewer comments on a pull request with no scanner finding.
- **Cost and time per pull request,** recorded, not targeted, until there is a baseline.

## What it needs from wolfproof

- **Now:** nothing. Phase 1 uses the gate as v1.15.0 ships it.
- **Phase 3:** backlog item #36 (only new findings block): IDs and locations for every finding, and
  the snapshot. That is wolfproof's own work, done there.
- **Every release:** the rulebook copy follows the pinned tag. The `wolfproof-release` skill's pin step
  could add this repository later; not until phase 4.

## Decisions

1. **Public.** A reusable workflow in a private repository can be called only by repositories with
   the same owner, and other teams need to call it.
2. **Each team's own key.** Without one, a team still gets the scanner summary.
3. **Default model: Sonnet 5.5,** for cost per pull request, until phase 2's measurements say otherwise.
4. **Built here,** separately from wolfproof, which stays with the session that maintains it.

## Phase 1 as built (v0.2.1)

- No `fail-on` input yet (phase 3). Inputs: `model`, `max-comments`, `paths-ignore`, and `review-ref`
  for this repository's own self-review.
- Pinned: `claude-code-action` v1.0.250, chosen over v1.0.267 because that was a day old;
  `actions/checkout` v7.0.1; `upload-artifact` v7.0.2; `download-artifact` v8.0.2.
- Summary-only mode when there is no key, or the pull request comes from a fork.
- After Claude, a script lists the comments it posted and flags any on an unchanged line, in the
  summary and as a workflow warning.
- The plugin has a `PreToolUse` hook: `gh pr create` (or `gh pr new`) is denied until
  `/wolfproof-review` has prepared a review of HEAD against the pull request's base. It is a nudge
  for Claude, off with `WOLFPROOF_REVIEW_HOOK=off`; the workflow stays the review every PR gets.
