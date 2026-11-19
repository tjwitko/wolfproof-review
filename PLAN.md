# wolfproof-review: plan

A pull-request reviewer for legacy repositories. Wolfproof's scanners supply the evidence, wolfproof's
rules are the guideline, and a model comments on the lines the pull request changed. By default it
never fails the build, so a repository with years of findings can adopt it on day one.

Status: phase 1. The reviewer runs on this repository's own pull requests; see "Phase 1 as built".

## How it differs from the wolfproof gate

| | wolfproof gate | wolfproof-review |
|---|---|---|
| Judges | the whole repository | the lines this pull request changed |
| Existing findings | block | listed once, in a summary, never blocking |
| Result | clean / blocked / incomplete, fails the build | comments; fails the build only if a team opts in (phase 3) |
| Who decides | deterministic checks only | the checks, then a model reading the code |
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

2. **review** — `REVIEW_API_KEY`, `contents: read`, `pull-requests: write`. Runs no project code.
   - Downloads the artifact.
   - `scripts/sort-findings.mjs` sorts every finding into three groups: **on a changed line**, **in a
     changed file**, and **already there**. Deterministic, no AI.
   - `scripts/summary.mjs` posts one summary comment from that sort, updated in place on each push:
     counts by check, the changed-line findings in full, the rest collapsed.
   - `scripts/review.mjs run` runs the `wolfproof-reviewer` agent from this repository's plugin, as
     plain API calls to the provider the team chose: Anthropic, or any OpenAI-compatible endpoint. The
     model gets the sorted findings, the diff and the rulebook, and posts inline
     comments with `mcp__github_inline_comment__create_inline_comment`.

**The model can add to the scanners' findings but cannot remove them.** The summary is written by a
script, so a pull request that talks the model out of a finding (prompt injection in a comment or a
string) still has that finding in the summary.

## What the model is told

The agent prompt lives once, in `plugins/wolfproof-review/agents/wolfproof-reviewer.md`. The GitHub
job and local use both load it. The rules it gives the model:

- **Changed lines only.** Inline comments go on lines this pull request added or changed. Issues
  elsewhere are left to the summary.
- **Read before repeating.** For each scanner finding on a changed line, read the code and say whether
  it holds. Wolfproof has false positives (`docs/candidate-rules.md` records them), and "the scanner
  says" without reading is noise.
- **Name the rule.** Each comment names the wolfproof check it comes from, from the rulebook, says what
  goes wrong and suggests a fix.
- **Same rules, missed by the scanners.** The model may flag something in the changed code that a rulebook
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

One file and one secret, `REVIEW_API_KEY`:

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
      REVIEW_API_KEY: ${{ secrets.REVIEW_API_KEY }}
```

Inputs, all optional: `provider` (`anthropic` or `openai`), `model` (default Sonnet 5.5, `claude-sonnet-5-5`,
for anthropic), `base-url`, `max-comments`, `paths-ignore`,
and later `fail-on: new-blocking` (phase 3).

For local use: `/plugin marketplace add tjwitko/wolfproof-review`, then install `wolfproof-review`,
then `/wolfproof-review main`. If wolfproof is installed in the project, the command runs it by path
(`node node_modules/wolfproof/bin/validate.mjs . --json`, never `npx`); otherwise it reviews without
scanner evidence and says so at the top.

## Security

- **The key stays out of the job that runs code.** See the two jobs above.
- **No forks.** A fork's pull request gets no secrets under `pull_request`, so the review job skips
  with a notice. The workflow never uses `pull_request_target`, which would hand fork code the key.
- **The model's tools are ours, and only four:** `read_file`, `grep`, `glob` and
  `create_inline_comment`, implemented in `scripts/agent.mjs`. No shell, no network, no file
  writes. With no shell, a prompt injection has nothing to run.
  - **Paths are confined** to `pr-head`, the scan's files and the rulebook, after `realpath`, so a
    symlink the pull request carries (to `/proc/self/environ`, say) reads nothing outside them.
  - **`grep` runs without a shell,** with the pattern after `-e` and `--`, and with an environment
    of `PATH` and `LC_ALL` only, so neither the key nor the token reaches it.
  - **The comment tool refuses** a line the change did not add or modify, and a comment past the
    limit, before anything is posted. The after-run check then reads the comments back and checks
    them against GitHub's own diff of the pull request (`pulls/{pr}/files`), not this job's diff and
    parser, so a fault in either shows up there instead of being passed twice.
  - **The log** gets each call's tool name and outcome, never content, and a provider's text never
    starts a line, so it cannot become a workflow command.
- **The scan's artifact is the pull request's to shape.** The scan job runs its code, so the review
  job keeps only the four files the scan hands over (`diff.patch`, `files.txt`, `result.json`,
  `meta.json`), as plain files, and writes everything else itself. The head commit for comments comes
  from the workflow's event. The diff and the file list are computed again in the review job, from
  the pull request's commits, with attributes from an empty tree, so a `.gitattributes` in the pull
  request (`-diff`, `binary`) cannot hide a file's lines. The lines the model may comment on are the
  ones that diff adds or modifies, read hunk by hunk by each header's line counts, so a changed line
  that looks like a file header is still a line; a file git sees as binary by its content has none. A
  scan diff that differs is flagged in the log and the summary.
- **The key is in one step's environment:** the Review step's. A test fails if another step, or the
  job, gets it.
- **The key goes only to the provider's URL.** Requests refuse redirects, since `fetch` would carry
  `x-api-key` to another host. A rejected key is reported as "rejected the API key", never with the
  provider's text, and any other error has the key, and any 8-character piece of it, cut out before
  it reaches `run.json` or the summary.
- **The provider sees the pull request.** Whatever the team's provider is, the diff and the files the
  model reads go to it. A team that needs them kept in-house points `base-url` at its own gateway.
- **Everything is pinned:** wolfproof by tag, every action by SHA. The plugin version is pinned in
  the workflow, and Dependabot proposes updates.

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
  GitHub's diff of the pull request. Any miss fails CI.
- **No scanner finding dropped (deterministic).** Every finding the sort put on a changed line appears
  in the summary.
- **Recall on known defects.** Pull requests that add the defects behind wolfproof's corpus fixtures
  (the webhook series, whose verdicts are known) to a legacy repository. Target, to revisit: at least
  8 in 10 flagged, inline, on the right line.
- **Noise on real history.** Replay 20 merged pull requests from each legacy repository, and have a
  person mark each comment useful or not. Targets, to revisit: at least 7 in 10 useful, and a median
  of 3 or fewer comments on a pull request with no scanner finding.
- **Cost and time per pull request,** recorded, not targeted, until there is a baseline. `run.json`
  records each run's turns and tokens: uncached input, read from the cache, written to it, and
  output.
- **Per provider and model.** Each measurement is taken per provider and model, so a team can see
  what a cheaper or a self-hosted model gives up.

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
5. **Plain API calls, any provider.** The review job calls the model's API itself, with tools of its
   own, rather than running Claude Code through `claude-code-action`. A team can use Anthropic or any
   OpenAI-compatible endpoint, its requests are ordinary API usage, and the model's tools are exactly
   the four we wrote, with no permission mode to rely on.

## Phase 1 as built

- No `fail-on` input yet (phase 3). Inputs: `provider`, `model`, `base-url`, `max-comments`,
  `max-input-tokens`, `paths-ignore`, and `review-ref` for this repository's own self-review.
- The key: `REVIEW_API_KEY`. `ANTHROPIC_API_KEY` is still read for the anthropic provider when
  `base-url` is empty, so callers from before the rename keep working; it never goes to a gateway.
- Cost: Anthropic requests use automatic prompt caching (a top-level `cache_control`) and a
  `max_tokens` of 16,000 per turn. `max-input-tokens` (default 1,000,000) bounds a run's prompt
  tokens across its turns, cached or not; a turn that would go past it is not sent, and `run.json`
  and the summary say the run stopped at its budget. The ten self-review runs of the redesign's pull
  request used 253,000 to 566,000, before caching.
- Pinned: `actions/checkout` v7.0.1; `upload-artifact` v7.0.2; `download-artifact` v8.0.2;
  `actions/setup-node` v7.1.0.
- Summary-only mode when there is no key, or the pull request comes from a fork.
- The review writes `run.json`: outcome, model, turns, each tool call's name and result, comments
  posted and refused, tokens, and the provider's error if it failed. The summary shows the model and,
  on a failure, that error.
- After the review, a script lists the comments it posted and flags any on a line GitHub's own diff
  does not show as added or modified, in the summary and as a workflow warning. A comment on a file
  GitHub sends no patch for (a very large diff) is counted as unchecked, and the log notes any file
  where this job's diff and GitHub's disagree. GitHub ignores `.gitattributes` here: it diffs a file
  marked `-diff` or `binary` as text and takes line comments on it.
- Until v0.2.11 the review ran through `claude-code-action`. A probe on its v1.0.276 (run
  [44415312550](https://github.com/tjwitko/wolfproof-review/actions/runs/44415312550)) read the
  session's mode from its execution output: `default`, with Claude Code's own tools (Skill,
  CronCreate, EnterWorktree, Workflow and others) beside ours. The six it tried needed no permission
  and ran. No control run was made before the move to plain API calls, which removes the question.
- The plugin has a `PreToolUse` hook: `gh pr create` (or `gh pr new`) is denied until
  `/wolfproof-review` has prepared a review of HEAD against the pull request's base. It is a nudge
  for Claude, off with `WOLFPROOF_REVIEW_HOOK=off`; the workflow stays the review every PR gets.
