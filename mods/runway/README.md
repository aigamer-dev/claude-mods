# runway

**Know before you run out.** runway shows your Claude Code usage limits, tracks your tasks, forecasts how long they will take, and pauses and resumes your work safely when the 5-hour window runs out.

## Contents

- [Features](#features)
- [Install](#install)
- [Commands](#commands)
- [The limit guard](#the-limit-guard)
- [Estimates that improve](#estimates-that-improve)
- [Agents at any depth](#agents-at-any-depth)
- [Setup for your agents](#setup-for-your-agents)
- [Development](#development)

## Features

| | |
|---|---|
| **Live limits** | The 5-hour and weekly limits in a pane you open with `/eta`: bars that follow the pane's width and turn yellow then red as a limit fills, with the estimate for your tasks and a countdown to the reset. |
| **Task tracker** | Your task list with a progress bar, active tasks first, each finished task shown over or under its estimate, and EGM subagent steps. |
| **Agent tree** | Every running agent at any depth, with its type, description and running time. |
| **Forecast** | ETA, token estimate and a verdict on whether the work fits in the 5-hour window. |
| **Self-calibrating** | The estimator learns from finished tasks, turns and agent runs. |
| **Limit guard** | Checkpoints, writes an after-action report (AAR), pauses and resumes after the reset. A banner shows what it is doing and counts down to the resume. |
| **Status line** | One line under the prompt: a mini bar for the 5h limit, the reset countdown, the week, and an ETA with a fits / won't-fit verdict. |
| **Held prompts** | Prompts you type while the guard is active are saved, not lost, and handled first on resume. |

## Install

```bash
claude plugin marketplace add aigamer-dev/claude-armory
claude plugin install runway@claude-armory
```

Restart Claude Code. Then run `/runway-setup` once (see [Setup for your agents](#setup-for-your-agents)).

## Commands

Type `/eta ` and the typeahead offers the subcommands.

| Command | What it does |
|---|---|
| `/eta` | Opens the pane: limits, tasks and the forecast. |
| `/eta pause` | Steps away on purpose. Running work finishes and checkpoints, the AAR is written, then the session holds until you run `/eta resume`. It never resumes by itself and survives a restart. |
| `/eta resume` | Continues from the AAR right now, without waiting for the reset. Use it when you are back, after you reset the limits by hand, or after you switch account. With no saved pause it uses the newest AAR of the folder. |
| `/eta bypass <prompt>` | Runs one prompt with the guard lifted for that turn only. |
| `/eta override` | Lifts the guard in every session until the 5-hour window resets. |
| `/eta guard on` | Turns the guard back on after an override. |
| `/runway-setup` | Adds the agent-coordination rules to your `~/.claude/CLAUDE.md` (see below). |

## The limit guard

When the 5-hour window is nearly spent and the remaining work will not fit before the reset, the guard steps in:

1. **Drain.** No new work starts. Running calls and agents finish and checkpoint.
2. **Write.** The AAR is written: what was asked, what is done, what is in progress, and the next steps.
3. **Wait.** The session holds until the window resets. Long waits clear the session first, so the resume reads the AAR instead of a cold cache.
4. **Resume.** After the reset the session continues from the AAR.

While the guard is active your other prompts are not sent to the model. They are saved verbatim and written, with no model call, onto the top of the AAR, so the resume handles them first. If the guard is released instead, they are handed back to you.

The guard is shared across sessions: a trip in one session trips the others in the same window, and the thresholds tighten with the number of threads that must each write an AAR.

## Estimates that improve

The estimator learns from finished todos, from every finished main-loop turn (pace and token rate), from every finished agent run (per subagent type), and from the 5-hour-percent-per-token rate of each limit reading. It leaves the "still learning" state after five samples of any of the first three and three rate readings, and keeps refining after that. With no todo list, the running turn is forecast from the learned turn length once five turns are known. The pane shows how many of each it learned from.

## Agents at any depth

Agents can start agents, which can start more. The guard tracks all of them however deep the tree goes, from the events of each agent's own loop together with the agent list.

- While the guard is active, no agent can start at any depth.
- An agent that keeps calling tools after the checkpoint request is stopped.
- Past the drain limit, every remaining agent turn is aborted, deepest first and the main loop last.

Claude Code has no per-agent stop call, so a stop is a refused tool call or an aborted turn.

## Setup for your agents

Run `/runway-setup` once, and again after updates. It adds one marked block to `~/.claude/CLAUDE.md` so that every agent estimates its tasks, names its subagent types and reports to the estimator. The estimator can only learn from data your agents give it.

- The block sits between `runway:begin` and `runway:end` marker lines, so a second run replaces it in place.
- A dated backup is made before every change, and the write is atomic.
- It refuses to touch a file whose markers are lone, reversed or repeated, so it never deletes your text.
- To undo it:

  ```bash
  python3 "${CLAUDE_PLUGIN_ROOT}/skills/runway-setup/setup.py" --remove
  ```

## Development

```bash
claude plugin test mods/runway
python3 mods/runway/skills/runway-setup/test_setup.py
```

| File | Role |
|---|---|
| `hooks/register.tsx` | The mod: pane, commands and the guard's hooks |
| `hooks/guard.ts` | Pure guard logic: thresholds, the read-only allowlist, AAR paths, completions |
| `hooks/agents.ts` | The agent tree used to track and stop agents at any depth, and to draw it |
| `hooks/view.ts` | The pane and status line as plain data, laid out for the pane's width |
| `hooks/estimator.ts` | The self-calibrating estimator |
| `skills/runway-setup/` | The `/runway-setup` skill and its script |
