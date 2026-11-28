# Changelog

All notable changes to this collection are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and each extension is versioned on its own with [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- MIT license.

## claude-armory

### 2026-11-28
- The collection is now called **claude-armory** (it was `claude-mods`). The marketplace id is `claude-armory`, so install with `usage-eta@claude-armory`.
- Product-style README, a guide for usage-eta, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `AGENTS.md` / `CLAUDE.md` for people who build with agents.

## usage-eta

### [0.2.0] - 2026-11-28
#### Added
- Agents are tracked at any depth. While the guard is active no agent starts at any depth, an agent that keeps calling tools after the checkpoint request is stopped, and past the drain limit every remaining agent turn is aborted, deepest first.
- `/usage-eta-setup` skill: adds one marked, idempotent block of agent-coordination rules to `~/.claude/CLAUDE.md`, with a dated backup. `--remove` undoes it.
- `/eta` subcommands (`pause`, `resume`, `bypass`, `override`, `guard on`) appear in the typeahead.
#### Changed
- Pauses carry a claim, so two sessions that adopt the same saved pause no longer both resume it, and a session that wakes after another one resumed does not resume again.
- A step that outlives the guard's lock timeout can no longer undo a later `/eta override`.
- A bypassed prompt that never starts no longer holds the drain open.
- The read-only command allowlist refuses a nested `.git` in the AAR folder, `git -C` into it, relative `-C` paths, `--no-index`, `--ext-diff` and `--textconv`. It steers an honest model and is not a sandbox.
- `setup.py` refuses lone, reversed or repeated markers and a usage-eta section without markers, writes atomically, and follows symlinks.

### [0.1.5] - 2026-11-24
- `/eta pause`: a manual pause that only `/eta resume` ends and that survives a restart.

### [0.1.4] - 2026-11-24
- The estimator learns from every finished turn and agent run, not only finished todos.

### [0.1.3] - 2026-11-24
- `/eta resume` continues from the AAR without waiting for the reset.

### [0.1.2] - 2026-11-24
- `/eta bypass <prompt>` runs one prompt with the guard lifted.
- Prompts typed while the guard is active are saved and written onto the top of the AAR.

### [0.1.1] - 2026-11-24
- Fixed a stuck learning phase, added `/eta override`, and fixed the AAR guard block on Windows.

### [0.1.0] - 2026-11-07 to 2026-11-22
- First release: the usage and ETA pane, task tracking (including EGM steps), a self-calibrating estimator, and the limit guard that writes an AAR and resumes after the reset, with a graceful drain, thread-aware thresholds and a trip shared across sessions.
