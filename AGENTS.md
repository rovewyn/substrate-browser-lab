# Repository Guidelines

## Project Structure & Module Organization

This lab studies Substrate browser actors, Playwright MCP integration, SuspendActor/ResumeActor behavior, and capacity benchmarks.

`README.md` is the entry point. `.githooks/` contains Git hooks; `scripts/` contains setup helpers. Use `experiments/` for experiment code and `data/` for useful structured outputs, such as JSON or CSV. Separate reusable helpers from individual experiments. Publish prose findings on `rovewyn.github.io`. Do not generate or retain prose reports here by default.

## Lab Scope & Agent Restrictions

Agents must not add CI workflows, including GitHub Actions, or write test code, including temporary test scripts. Do not add test suites, test frameworks, test mocks, test-only fixtures, coverage infrastructure, or CI/test dependencies. Keep work focused on requested experiments, benchmarks, data collection, and analysis. The local Gitleaks commit check remains mandatory.

## Setup & Experiment Commands

Run `sh scripts/install-hooks.sh` after cloning to enable Gitleaks checks. Install Gitleaks first; see `README.md`.

Document experiment setup, commands, configuration, and expected outputs in `README.md`. Commit dependency manifests and lockfiles.

## Coding Style & Naming Conventions

No formatter or linter is configured. Follow the conventions of the language introduced. Use descriptive names, such as `suspend-resume` or `browser-capacity`. All documentation, code comments, docstrings, commit messages, and pull request titles and descriptions must be written in English. Explain lifecycle assumptions and benchmark parameters.

## Experiment Validation & Data

Validate work through direct experiment runs and manual output inspection. State which browser state must survive suspend/resume. Structured data should record parameters, environment, units, timing, failures, and resource measurements needed to interpret results. Distinguish simulated observations from actual Substrate runs.

## Commit & Pull Request Guidelines

Commit messages and pull request titles must follow Conventional Commits: `type(scope): description`, with an optional scope. Example: `feat: add suspend-resume experiment`.

Describe changes, link relevant issues, and include experiment commands and observed results. Include screenshots for browser-visible changes. Document benchmark reproduction and any omitted validation.

## Security & Configuration

Never commit credentials, tokens, cookies, private browser profiles, or personal data. Use synthetic experiment data and placeholders such as `<REDACTED>` or `example.com`. Remove or redact sensitive data in logs, traces, screenshots, URLs, reports, and PR content before committing, sharing, or publishing. Document environment variable names without their values.

Before every commit, `.githooks/pre-commit` runs `gitleaks git --pre-commit --staged --redact`. Commit only after a successful scan with no findings. Missing tools and scan errors block commits. Never bypass the hook with `--no-verify`. Restage and rescan after changes.
