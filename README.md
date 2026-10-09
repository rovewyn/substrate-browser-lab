# substrate-browser-lab

Browser actors on [Substrate](https://github.com/agent-substrate/substrate): Playwright MCP, SuspendActor/ResumeActor validation, and capacity benchmarks.

Reports will be published on [rovewyn.github.io](https://rovewyn.github.io/).

## Contributor Setup

Install [Gitleaks](https://github.com/gitleaks/gitleaks#installing) with support for the `git` command, then enable the repository hooks after cloning:

```sh
brew install gitleaks # macOS; see the link above for other platforms
sh scripts/install-hooks.sh
```

The versioned `.githooks/pre-commit` hook scans staged changes before every commit. Findings, scan errors, or a missing Gitleaks executable block the commit. Scan output redacts secret values. Fix the issue, stage the corrected files, and retry. Do not bypass the hook with `--no-verify`.

Hook activation is local to each clone; repeat the setup for new clones. The installer preserves existing hooks by refusing to switch from another configured hooks path or active default hooks. Resolve those conflicts before retrying.
