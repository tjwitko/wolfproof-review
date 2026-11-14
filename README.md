# wolfproof-review

A pull-request reviewer for legacy repositories. [wolfproof](https://github.com/tjwitko/wolfproof)'s
scanners supply the evidence, wolfproof's rules are the guideline, and Claude comments only on the
lines the pull request changed. It never fails the build, so a repository with years of existing
findings can turn it on today.

wolfproof itself is a gate: it judges the whole repository and blocks. On old code that means it
blocks on day one, for code nobody touched. This reviewer runs the same scanners and asks a narrower
question: what did this change add or touch?

## What a review looks like

- **One summary comment**, rewritten on every push. It has three sections:
  - findings on lines the pull request added or modified;
  - findings in files it touched;
  - a folded list of blocking findings already in the repository, untouched by the change.
- **Inline comments from Claude**, on changed lines only, up to 15 per run. Each one names the
  wolfproof rule it falls under and suggests a fix.
  - For each scanner finding on a changed line, Claude reads the code. It says whether the finding
    holds or is probably a false positive.
  - It also flags what wolfproof's rules describe but no scanner reported, marked "Not from a
    scanner".

Claude can add to the scanners' findings, but it cannot remove them. The summary is written by a
script, so a pull request that talks Claude out of a finding still shows that finding.

## Add it to a repository

1. Add your Anthropic API key as a repository secret named `ANTHROPIC_API_KEY` (Settings → Secrets
   and variables → Actions). Each team uses its own key and pays for its own reviews. Without a key,
   the scanner summary is still posted, and Claude's review is skipped.
2. Add `.github/workflows/wolfproof-review.yml`:

```yaml
name: wolfproof review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
jobs:
  wolfproof-review:
    uses: tjwitko/wolfproof-review/.github/workflows/review.yml@v0.2.8
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

That is all. Optional inputs, under `with:`:

| input | default | |
|---|---|---|
| `model` | `claude-sonnet-5-5` | The Claude model that reviews |
| `max-comments` | `15` | The most inline comments one run posts, 1 to 50 |
| `paths-ignore` | *(none)* | Globs, one per line or comma-separated, to leave out, such as generated or vendored code |

Pin the version, as above. Dependabot's `github-actions` updater proposes new releases.

## Use it on your own machine

The same reviewer is a Claude Code plugin:

```text
/plugin marketplace add tjwitko/wolfproof-review
/plugin install wolfproof-review@wolfproof-review
```

Then, on a branch:

```text
/wolfproof-review main
```

To update to a newer release, refresh the marketplace, then update the plugin, and restart Claude
Code or run `/reload-plugins`:

```bash
claude plugin marketplace update wolfproof-review
claude plugin update wolfproof-review@wolfproof-review
```

It reviews your branch against `main`, uncommitted changes to tracked files included, and prints the
comments in the chat instead of posting them.
- **With wolfproof,** it runs wolfproof first. wolfproof runs your tests and builds, so this can take
  a few minutes. It looks in two places:
  - **the project's own install,** `node_modules/wolfproof`
    (`npm install --save-dev github:tjwitko/wolfproof#v1.16.4`), which wins when it is there, since it
    is the version the project chose;
  - **`WOLFPROOF_BIN`,** for a repository that does not install it, such as one that is not a Node
    project. Set it to wolfproof's directory, to its `bin/validate.mjs`, or to a command on your
    `PATH` such as `wolfproof`. Set it where Claude Code's commands see it, for example under `env` in
    `~/.claude/settings.json`:

    ```json
    { "env": { "WOLFPROOF_BIN": "~/tools/wolfproof" } }
    ```

    One way to get a copy: `git clone --branch v1.16.4 https://github.com/tjwitko/wolfproof ~/tools/wolfproof`,
    then `npm ci` inside it.
- **Without wolfproof,** it reviews against the rulebook alone and says so. Add `--no-scan` to skip the
  scan deliberately.

### Before Claude opens a pull request

The plugin adds a hook. When Claude runs `gh pr create` (or `gh pr new`), the hook checks whether
`/wolfproof-review` has reviewed the commit being proposed, against the pull request's base. If it
has not, the command is stopped and Claude is told to run the review first. Claude then reviews,
fixes or reports what it finds, and opens the pull request.

- **A new commit needs a new review.** With wolfproof installed, each review runs your tests and
  build, so expect a few minutes before each pull request Claude opens.
- **Turn it off** by setting `WOLFPROOF_REVIEW_HOOK=off` in Claude Code's environment, for example
  under `env` in `.claude/settings.json`, or by disabling the plugin.
- **It is a nudge for Claude, not a control.** It lets the command through whenever it cannot tell,
  for example outside a git repository, and it does not check that Claude acted on the review. The
  GitHub workflow is what reviews every pull request, whoever opens it.
- The record of the last review is `wolfproof-review.json` in the repository's git directory, which
  git does not track.

## How it works, and why it is safe to run

The workflow has two jobs.

- **`scan`** runs wolfproof on the pull request. wolfproof runs the project's tests and builds, so
  this job has no secrets and a read-only token. It hands its result and the diff to the next job.
- **`review`** runs no code from the pull request.
  - The base branch is checked out at the root, and the pull request beside it, as files to read.
    This follows `claude-code-action`'s guidance for pull requests.
  - A script sorts the findings against the diff.
  - Claude reviews, with read, search and the inline-comment tool only: no shell, no edits, no
    network. Text in a pull request that tries to instruct Claude has nothing to run.
  - A script checks that every comment landed on a changed line, and posts the summary.

Pull requests from forks get no secrets, so they get the scanner summary in the job log only. The
workflow runs on `pull_request` only, never `pull_request_target`.

Everything is pinned: wolfproof by release tag, and `claude-code-action` and every other action by
commit SHA.

## Limits

- **Matching findings to lines is approximate** until wolfproof gives every finding a structured
  location. Today the location is read out of each finding's text, so a finding that names no file
  is matched by file kind: a dependency finding counts as touched when the change edits
  `requirements.txt`. That is why nothing here blocks.
- **It does not fail the build.** An opt-in to fail only on new blocking findings will follow
  wolfproof's support for snapshotting existing findings. See [PLAN.md](PLAN.md).
- **CodeQL is off.** wolfproof's CodeQL option is licensed for open-source code only without GitHub
  Advanced Security, so the reviewer does not turn it on.

## Development

```bash
node --test 'test/*.test.mjs'
```

- The scripts are plain Node with no dependencies, in `plugins/wolfproof-review/scripts/`.
- The reviewer's instructions are in `plugins/wolfproof-review/agents/wolfproof-reviewer.md`, the only
  copy. The workflow and the local command both read it.
- `plugins/wolfproof-review/rulebook/checks.md` is wolfproof's rulebook at the pinned tag. CI fails if
  the copy drifts.
- This repository reviews its own pull requests with the workflow at the pull request's version.

## Licence

[GNU Affero General Public License v3.0](LICENSE) © 2026 Tom Witkowski, for everything after v0.2.3. Releases up to and
including v0.2.3 remain under Apache-2.0. `plugins/wolfproof-review/rulebook/checks.md` is a copy of
`docs/checks.md` from [wolfproof](https://github.com/tjwitko/wolfproof), under the same licence.
