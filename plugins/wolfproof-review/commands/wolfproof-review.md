---
description: Review this branch's changes against wolfproof's rules, commenting only on lines it changed
argument-hint: "[base-branch] [--no-scan]"
allowed-tools: ["Bash(node \"${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs\" local:*)", "Read", "Grep", "Glob"]
---

Prepare the review inputs by running this command, with a Bash timeout of 900000 ms. When wolfproof
is installed in this project, or WOLFPROOF_BIN names a copy, the command runs it, and wolfproof runs
the project's tests and builds, which can take several minutes:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" local $ARGUMENTS
```

If it fails, show its error output and stop.

Otherwise its last line names an instructions file. Read that file and follow it exactly: it is the
wolfproof reviewer's instructions with this run's paths. If the command printed a note about
wolfproof not running, repeat that note in one line at the top of your reply.

Do not edit any file. This is a review only.
