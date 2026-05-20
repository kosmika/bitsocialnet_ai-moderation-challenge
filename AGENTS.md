# AGENTS.md

## Purpose

This file defines the always-on rules for AI agents working on `@bitsocial/ai-moderation-challenge`.
Use this as the default policy. Load linked playbooks only when their trigger condition applies.

## Surprise Handling

The role of this file is to reduce recurring agent mistakes and confusion points in this repository.
If you encounter something surprising or ambiguous while working, alert the developer immediately.
After confirmation, add a concise entry to `docs/agent-playbooks/known-surprises.md` so future agents avoid the same issue.
Only record items that are repo-specific, likely to recur, and have a concrete mitigation.

## Project Overview

`@bitsocial/ai-moderation-challenge` is a Bitsocial PKC community challenge package. It evaluates comment content against `community.rules` through an OpenAI-compatible model endpoint, without requiring a hosted Bitsocial moderation server.

## Instruction Priority

- **MUST** rules are mandatory.
- **SHOULD** rules are strong defaults unless task context requires a different choice.
- If guidance conflicts, prefer: user request > MUST > SHOULD > playbooks.

## Agent Operating Principles

- Before editing, state important assumptions when the task is ambiguous. Ask instead of silently choosing between materially different interpretations.
- Prefer the smallest implementation that solves the requested problem. Do not add speculative abstractions, configurability, or features.
- Keep diffs surgical. Do not refactor, reformat, rename, or "improve" adjacent code unless it is necessary for the task.
- Clean up only artifacts created by the current change, such as newly unused imports or dead helper code.
- For non-trivial work, define success criteria and verify them with the narrowest reliable checks before marking the task complete.

## LLM Knowledge Base Policy

Use compiled context for orientation, not as source of truth.

Source of truth:

- Code, tests, package manifests, docs, and runtime/live evidence when relevant.

Compiled context:

- `AGENTS.md`, directory-specific `AGENTS.md` files, `CLAUDE.md`, and repo-managed `.codex/`, `.cursor/`, and `.claude/` workflow files.
- `docs/agent-playbooks/**`, `docs/agent-runs/**`, `docs/agent-playbooks/known-surprises.md`, and tracked `llms.txt` / `llms-full.txt` files when present.

Agents may use compiled context to navigate quickly, but must verify against source files before making behavioral claims or edits. External code graph, RAG, MCP, or wiki tools are optional local accelerators unless the developer explicitly asks to make one part of the committed workflow.

## Task Router (Read First)

| Situation                                                                                                       | Required action                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime challenge code changed (`src/**`)                                                                       | Read `src/AGENTS.md`, then run `corepack yarn build`, `corepack yarn type-check`, and `corepack yarn test`                                                                                        |
| Tests changed (`tests/**`)                                                                                      | Read `tests/AGENTS.md`, then run `corepack yarn test` and the narrowest extra check that proves the change                                                                                        |
| `package.json` changed                                                                                          | Run `corepack yarn install` to keep `yarn.lock` in sync                                                                                                                                           |
| API request/response parsing, prompt handling, cache keying, or secret handling changed                         | Add or update Vitest coverage and use the moderation review checklist in `.codex/agents/moderation-reviewer.toml` or the equivalent Cursor/Claude agent                                           |
| `README.md`, package version, or release workflow changed                                                       | Verify docs against the code and use the `release` or `release-description` skill when preparing a release                                                                                        |
| Public docs or AI context changed (`README.md`, `AGENTS.md`, `src/AGENTS.md`, `tests/AGENTS.md`, docs pages, or `scripts/generate-llms-files.mjs`) | Run `corepack yarn llms:generate`; inspect and commit any resulting changes to `llms*.txt` so LLM indexes stay current                                           |
| Bug report in a specific file/line                                                                              | Start with a git history scan from `docs/agent-playbooks/bug-investigation.md` before editing                                                                                                     |
| Long-running task spans multiple sessions, handoffs, or spawned agents                                          | Use `docs/agent-playbooks/long-running-agent-workflow.md`, keep a machine-readable feature list plus a progress log, and run `./scripts/agent-init.sh --smoke` before starting a fresh task slice |
| New reviewable feature/fix started while on `master`                                                            | Create a short-lived `codex/feature/*`, `codex/fix/*`, `codex/docs/*`, or `codex/chore/*` branch from `master` before editing unless the user explicitly asks to work on `master`                 |
| New unrelated task started while another task branch is already checked out or being worked on by another agent | Create a separate worktree from `master`, create a new short-lived task branch there, and keep each agent on its own worktree/branch/PR                                                           |
| Open PR needs feedback triage or merge readiness check                                                          | Use the `review-and-merge-pr` skill to inspect bot/human feedback, fix valid findings, and merge only after verification                                                                          |
| Repo AI workflow files changed (`.codex/**`, `.cursor/**`, `.claude/**`)                                        | Keep Codex, Cursor, and Claude copies aligned when they represent the same workflow; update `AGENTS.md` if the default agent policy changes                                                       |
| GitHub operation needed                                                                                         | Use `gh` CLI, not GitHub MCP                                                                                                                                                                      |
| User asks for commit/issue phrasing                                                                             | Use `docs/agent-playbooks/commit-issue-format.md`                                                                                                                                                 |
| Surprising/ambiguous repo behavior encountered                                                                  | Alert developer and, once confirmed, document it in `docs/agent-playbooks/known-surprises.md`                                                                                                     |

## Stack

- Node.js 22+
- TypeScript 6 with `NodeNext`
- esbuild for the bundled ESM output
- Vitest for tests
- Zod for option and model-verdict validation
- `@pkcprotocol/pkc-js` community challenge APIs
- Corepack-managed Yarn 4
- Prettier
- release-it and trusted npm publishing through GitHub Actions

## Project Structure

```text
src/
├── index.ts    # Challenge metadata, PKC runtime entrypoint, model calls, cache handling
└── schema.ts   # Options, API format, branch, and model-verdict schemas
tests/
└── challenge.test.ts
scripts/
├── agent-hooks/          # Shared lifecycle hooks for AI tooling
├── agent-init.sh         # Fresh-session setup and smoke verification
└── create-task-worktree.sh
docs/
└── agent-playbooks/      # On-demand workflows for agents
```

## Core MUST Rules

### Package and Dependency Rules

- Use Corepack-managed Yarn 4, never npm for development commands. Run `corepack enable` once on a new machine before using `yarn`.
- Pin exact dependency versions (`package@x.y.z`), never `^` or `~`.
- Keep `yarn.lock` synchronized when dependency manifests change.
- Do not add a dependency when a small typed helper or existing standard library API is enough.

### Moderation and Security Rules

- Treat `apiKey`, inline prompts, prompt files, and cache paths as private community-node settings. Never copy secrets into public challenge metadata, docs examples, tests, logs, or cache payloads.
- Preserve fail-closed moderation behavior. If the provider is unavailable or returns malformed output, the challenge must not silently allow content.
- Do not fetch linked media or linked pages. The package may use URL metadata already present in the publication, but it must not retrieve external content during moderation.
- Keep model output schema-driven and strict. Validate provider output through `ModelVerdictSchema` or an equally strict schema before using it.
- Keep request construction deterministic and testable. Model payload changes should be covered by Vitest assertions against the outgoing `fetch` body.
- Keep cache keys derived from stable hashes of provider/model config, final prompt identity, community context, and target content. Do not store raw API keys, raw prompts, or raw publication content in persistent cache files.
- Keep branch semantics explicit: `allow` means the branch allows only `allow` verdicts; `review` means the branch routes `review` verdicts to PKC pending approval when paired with challenge settings.
- Content edits require extra care because PKC pending approval does not cover edits in the same way as new comments. Preserve the existing reject-on-review and reject-on-unavailable behavior unless the PKC API changes and tests prove the new behavior.
- Avoid logging raw model prompts, full model payloads, authorization headers, or private cache paths.

### TypeScript Rules

- Prefer `unknown` plus narrow type guards over `any`.
- Keep public exports stable unless the user explicitly asks for a breaking change.
- Use Zod for external or user-configured data boundaries.
- Keep module imports compatible with NodeNext ESM and the package `exports` map.
- Comments should explain non-obvious moderation, privacy, PKC, or provider-compatibility constraints. Remove comments that only restate the code.

### Git Workflow Rules

- Keep `master` releasable. Do not treat `master` as a scratch branch.
- If the user asks for a reviewable feature/fix and the current branch is `master`, create a short-lived task branch before making code changes unless the user explicitly asks to work directly on `master`.
- Name short-lived AI task branches by intent under the Codex prefix: `codex/feature/*`, `codex/fix/*`, `codex/docs/*`, `codex/chore/*`.
- Open PRs from task branches into `master` so review bots and CI run against the actual change.
- Use worktrees only when parallel tasks need isolated checkouts. One active task branch per worktree.
- If a new task is unrelated to the currently checked out branch, do not stack it on that branch. Create a new worktree from `master` and a separate short-lived task branch there.
- Always give a new worktree a descriptive name that reflects the task (e.g. `fix-login-redirect`, not `wt1`, `tmp`, `feature`, or a numbered slug), so it can be identified at a glance in a long list of worktrees. When using `./scripts/create-task-worktree.sh`, the `<slug>` argument must be that descriptive name.
- Prefer `./scripts/create-task-worktree.sh <feature|fix|docs|chore> <slug>` when you need a new task worktree and do not have a stronger repo-specific reason to create it manually.
- Treat branch and worktree as different things: the branch is the change set; the worktree is the checkout where that branch is worked on.
- After a reviewed branch is merged, prefer deleting it to keep branch drift and merge conflicts low.

### Bug Investigation Rules

- For bug reports tied to a specific file/line, check relevant git history before any fix.
- Minimum sequence: `git log --oneline` or `git blame` first, then scoped `git show` for relevant commits.
- Full workflow: `docs/agent-playbooks/bug-investigation.md`.

### Verification Rules

- Never mark work complete without verification.
- After code changes, run: `corepack yarn build`, `corepack yarn type-check`, `corepack yarn test`, and `corepack yarn format:check`.
- If only docs or AI workflow files changed, run `corepack yarn format:check` and any hook or script check directly affected by the change.
- If dependency manifests changed, run `corepack yarn install` before verification.
- Treat `corepack yarn npm audit` as advisory visibility, not a repo-wide blocking gate unless the user asks for one.
- Do not commit generated build output. `dist/` is ignored generated output; remove it after local verification if it exists.
- If verification fails, fix and re-run until passing or explain the blocker with exact commands and failure context.

### Tooling Constraints

- Use `gh` CLI for GitHub work (issues, PRs, actions, npm trusted publishing context, search).
- Do not use GitHub MCP for this repository.
- If many MCP tools are present in context, warn the user and suggest disabling unused MCPs.

### AI Tooling Rules

- Treat `.codex/`, `.cursor/`, and `.claude/` as repo-managed contributor tooling, not private scratch space.
- Keep equivalent workflow files aligned across all toolchains when their directories contain the same skill, hook, or agent.
- Keep shared behavior equivalent while preserving harness-specific models, config formats, hook entry points, and tool invocation syntax.
- Do not configure `.claude` agents to use `composer-2`; that model is Cursor-only.
- Standardize `.codex/agents/*.toml` on `gpt-5.4` unless the user explicitly requests a different model.
- When changing shared agent behavior, update the relevant files in `.codex/skills/`, `.cursor/skills/`, `.claude/skills/`, `.codex/agents/`, `.cursor/agents/`, `.claude/agents/`, `.codex/hooks/`, `.cursor/hooks/`, `.claude/hooks/`, and their hook or config entry points as needed.
- Review `.codex/config.toml`, `.cursor/hooks.json`, and `.claude/hooks.json` before changing agent orchestration or hook behavior, because they are the entry points contributors will actually load.
- Directory-specific auto-loaded rules live under `src/AGENTS.md`, `tests/AGENTS.md`, and `scripts/AGENTS.md`; read them before editing files in those trees.
- For work expected to span multiple sessions, keep explicit task state in a `feature-list.json` plus `progress.md` pair using `docs/agent-playbooks/long-running-agent-workflow.md`.
- If more than one human or toolchain needs the same task state, keep it in a tracked location such as `docs/agent-runs/<slug>/` instead of burying it in a tool-specific hidden directory.

### Project Maintenance Rules

- Keep README examples aligned with the code defaults in `src/schema.ts` and runtime behavior in `src/index.ts`.
- If package version changes, verify release notes/changelog output with the `release` skill and the GitHub workflow expectations in `README.md`.
- First-time npm publishing is manual; future version publishes are handled by `.github/workflows/publish.yml` when `package.json` changes on `master`.

## Core SHOULD Rules

- Keep context lean: delegate heavy/verbose tasks to subprocesses when available.
- Parallelize independent checks when the harness supports it.
- Add or update tests for bug fixes and non-trivial runtime behavior changes.
- When touching already-covered code, prefer extending nearby tests so important moderation behavior stays covered.
- When proposing or implementing meaningful code changes, include both a Conventional Commit title suggestion and a short GitHub issue suggestion using `docs/agent-playbooks/commit-issue-format.md`.
- When stuck on a bug, search the web for recent fixes/workarounds, especially for provider API shape changes or PKC package behavior.
- After user corrections, identify root cause and apply the lesson in subsequent steps.

## Common Commands

```bash
corepack yarn install
corepack yarn build
corepack yarn type-check
corepack yarn test
corepack yarn format
corepack yarn format:check
corepack yarn npm audit
./scripts/create-task-worktree.sh chore ai-workflow-improvement
./scripts/agent-init.sh --smoke
```

## Playbooks (Load On Demand)

Use these only when relevant to the active task:

- Hooks setup and scripts: `docs/agent-playbooks/hooks-setup.md`
- Long-running agent workflow: `docs/agent-playbooks/long-running-agent-workflow.md`
- Commit/issue output format: `docs/agent-playbooks/commit-issue-format.md`
- Skills/tools setup and rationale: `docs/agent-playbooks/skills-and-tools.md`
- Bug investigation workflow: `docs/agent-playbooks/bug-investigation.md`
- Known surprises log: `docs/agent-playbooks/known-surprises.md`
