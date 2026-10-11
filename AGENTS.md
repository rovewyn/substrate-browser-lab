# Repository Guidelines

## Project Structure & Module Organization

This lab studies Substrate browser actors, Playwright MCP, suspend/resume behavior, and capacity.

`README.md` is the entry point. `.githooks/` contains Git hooks; `scripts/` contains reusable setup helpers; `experiments/` contains experiment scripts and their required image recipes, runtime configuration, dependency manifests, and lockfiles.

This repository stores experiment code and operating instructions only. Keep all experiment results locally in ignored `outputs/` or `state/`. Never commit or push reports, measured results, JSON/CSV result datasets, screenshots, logs, traces, browser profiles, or snapshot artifacts, including redacted versions. Do not embed measured findings in README.md or PR content. Publishing results or an article requires a separate explicit user instruction.

## Lab Scope & Agent Restrictions

Agents must not add CI workflows (including GitHub Actions), test code (including temporary scripts), test suites, test frameworks, mocks or fixtures for tests, coverage infrastructure, or CI/test dependencies. Focus on experiments, benchmarks, data collection, and analysis. Gitleaks commit checks remain mandatory.

## Setup & Experiment Commands

Install Gitleaks, then run `sh scripts/install-hooks.sh` after cloning. Document experiment commands, configuration, and expected outputs in `README.md`. Commit dependency manifests and lockfiles.

## Coding Style & Naming Conventions

Use the introduced language's conventions and descriptive names such as `suspend-resume`. All documentation, comments, docstrings, commit messages, and PR titles and descriptions must be in English. Explain lifecycle assumptions and benchmark parameters.

## Experiment Execution & Local Results

Validate through direct experiment runs and manual output inspection. Record parameters, environment, units, timing, failures, and resource measurements in ignored local output files. State suspend/resume persistence expectations in the operating instructions. Distinguish simulated observations from actual Substrate runs in local records. Preserve existing local results when reorganizing or cleaning the checkout.

## Git Workflow & Cleanup

Use `codex/` feature branches during development. After merging a PR, cleanup must remove both its local and remote feature branches:

1. Confirm neither branch contains new or unmerged work; delete the remote feature branch.
2. Run `git fetch --prune origin`.
3. Switch away from the local feature branch: primary clones may use `git switch main`, then `git merge --ff-only origin/main`; linked worktrees must use `git switch --detach origin/main`.
4. Delete the local feature branch after switching away.

These checkout requirements apply to post-merge cleanup. Preserve uncommitted changes and branches used by other worktrees.

## Commit & Pull Request Guidelines

Commit messages and PR titles must follow Conventional Commits: `type(scope): description`; scope is optional. Example: `feat: add suspend-resume experiment`.

Describe code changes, link relevant issues, and provide experiment commands. Describe code validation and disclose omitted execution. Do not attach experiment reports, measured outcomes, screenshots, or result data to commits or PRs.

## Security & Configuration

Never commit credentials, tokens, cookies, private browser profiles, or personal data. Use synthetic data and placeholders such as `<REDACTED>` or `example.com`. Redact sensitive data in logs, traces, screenshots, URLs, reports, and PR content before committing, sharing, or publishing. Document environment variable names without values.

The pre-commit hook must pass `gitleaks git --pre-commit --staged --redact` with no findings. Missing tools or scan errors block commits. Never use `--no-verify`. Restage and rescan after changes.
