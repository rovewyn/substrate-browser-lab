# Repository Guidelines

## Project Structure & Module Organization

This lab studies Substrate browser actors, Playwright MCP, suspend/resume behavior, and capacity.

`README.md` is the entry point. `.githooks/` contains Git hooks; `scripts/` contains setup helpers. Use `experiments/` for experiment code and `data/` for structured JSON/CSV outputs. Publish prose findings on `rovewyn.github.io`; do not generate or retain prose reports by default.

## Lab Scope & Agent Restrictions

Agents must not add CI workflows (including GitHub Actions), test code (including temporary scripts), test suites, test frameworks, mocks or fixtures for tests, coverage infrastructure, or CI/test dependencies. Focus on experiments, benchmarks, data collection, and analysis. Gitleaks commit checks remain mandatory.

## Setup & Experiment Commands

Install Gitleaks, then run `sh scripts/install-hooks.sh` after cloning. Document experiment commands, configuration, and expected outputs in `README.md`. Commit dependency manifests and lockfiles.

## Coding Style & Naming Conventions

Use the introduced language's conventions and descriptive names such as `suspend-resume`. All documentation, comments, docstrings, commit messages, and PR titles and descriptions must be in English. Explain lifecycle assumptions and benchmark parameters.

## Experiment Validation & Data

Validate through direct experiment runs and manual output inspection. Record parameters, environment, units, timing, failures, and resource measurements in structured data. State suspend/resume persistence expectations. Distinguish simulated observations from actual Substrate runs.

## Git Workflow & Cleanup

Use `codex/` feature branches during development. After merging a PR, cleanup must remove both its local and remote feature branches:

1. Confirm neither branch contains new or unmerged work; delete the remote feature branch.
2. Run `git fetch --prune origin`.
3. Switch away from the local feature branch: primary clones may use `git switch main`, then `git merge --ff-only origin/main`; linked worktrees must use `git switch --detach origin/main`.
4. Delete the local feature branch after switching away.

These checkout requirements apply to post-merge cleanup. Preserve uncommitted changes and branches used by other worktrees.

## Commit & Pull Request Guidelines

Commit messages and PR titles must follow Conventional Commits: `type(scope): description`; scope is optional. Example: `feat: add suspend-resume experiment`.

Describe changes and observed results, link relevant issues, and provide reproduction commands. Include screenshots for browser-visible changes and disclose omitted validation.

## Security & Configuration

Never commit credentials, tokens, cookies, private browser profiles, or personal data. Use synthetic data and placeholders such as `<REDACTED>` or `example.com`. Redact sensitive data in logs, traces, screenshots, URLs, reports, and PR content before committing, sharing, or publishing. Document environment variable names without values.

The pre-commit hook must pass `gitleaks git --pre-commit --staged --redact` with no findings. Missing tools or scan errors block commits. Never use `--no-verify`. Restage and rescan after changes.
