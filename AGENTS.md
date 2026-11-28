# AGENTS.md

Guidance for AI agents (Claude Code, Codex and others) that work on this repository. Read it before you change anything. `CLAUDE.md` imports this file.

## What this repository is

claude-armory is a public marketplace of Claude Code extensions: mods, skills, plugins and hooks. Each extension lives in `mods/<name>/` and installs on its own.

```
.claude-plugin/marketplace.json     the catalog (name: claude-armory)
mods/<name>/
  .claude-plugin/plugin.json        name, version, description
  hooks/                            mod and hooks (TypeScript / TSX)
  skills/<skill>/SKILL.md           skills
  README.md                         the extension's guide
README.md  CHANGELOG.md  CONTRIBUTING.md  SECURITY.md  AGENTS.md  CLAUDE.md
```

Today there is one extension, `usage-eta` (usage limits, ETA and the limit guard).

## Rules you must follow

1. **Never push to `master`.** It is protected. Work on a branch and open a pull request; the maintainer merges.
2. **Only finished, public-ready work goes in the repository.** Never add or commit research notes, plans, reports, scratch files, unfinished code, the `.claude/` folder, memory files, secrets, tokens or `.env` files. Keep working material outside the repo.
3. **Check before every commit.** Run `git status` and look at the staged file list. If a path breaks rule 2, unstage it.
4. **No secrets, ever.** Not in code, tests, docs, logs or commit messages.
5. **Do not weaken safety checks** (the guard's allowlist, `setup.py`'s marker checks) to make a test pass. Fix the cause.
6. **Tell the truth in docs and changelog.** If something is untested or limited, say so.

## Commands

```bash
claude plugin test mods/usage-eta                          # plugin tests
python3 mods/usage-eta/skills/usage-eta-setup/test_setup.py  # setup script tests
```

Run the tests for any extension you touch, and make them pass before you open a pull request.

## How to make a change

1. Branch from `master`.
2. Keep pure logic in its own module (for example `guard.ts`, `agents.ts`, `estimator.ts`) and the hook wiring in `register.tsx`, so the logic is unit tested without the engine.
3. Add or update a test for every behavior you change. Prefer a test that fails without your change.
4. Update the extension's `README.md`, bump its version in `plugin.json`, and add an entry to `CHANGELOG.md`.
5. Commit with a summary that starts with the extension, for example `usage-eta 0.2.1: fix the resume check`, and a body that says why.
6. Open a pull request against `master` and describe what changed, why, and how you tested it.

## Adding a new extension

Follow [CONTRIBUTING.md](CONTRIBUTING.md): create `mods/<name>/` with a `plugin.json`, code, a `README.md` and tests; register it in `.claude-plugin/marketplace.json`; add it to the catalog table in `README.md` and to `CHANGELOG.md`.

## Conventions

- TypeScript with the types the Claude Code plugin SDK provides; strict, no `any` unless an engine type forces it, and say why.
- Hooks must not block the session: bound every wait, and never let one hung call freeze the others.
- Anything that edits a user's files (for example `~/.claude/CLAUDE.md`) must be idempotent, make a backup first, write atomically and refuse on an unexpected layout instead of guessing.
- Keep docs short and concrete. Use tables for commands and options.

## Building on top of this repository

To build your own extension with an agent, point it at this file and at the closest existing extension (`mods/usage-eta`) as a pattern, then follow "Adding a new extension". The agent should read `CONTRIBUTING.md` and `SECURITY.md` first.
