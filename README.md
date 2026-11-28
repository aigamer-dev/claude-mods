# claude-mods

Personal mods for Claude Code (desktop and CLI).

## usage-eta
Shows the 5-hour and weekly usage limits, a task tracker (including EGM subagent steps), and an ETA, token and fits-in-the-5h-window forecast. The estimator calibrates itself from each finished task. Open it with `/eta`. `/eta override` lifts the limit guard in every session until the 5h window resets; `/eta guard on` turns it back on. `/eta bypass <prompt>` runs one prompt with the guard lifted for that turn only. `/eta resume` continues from the AAR right now, without waiting for the reset (use it after you reset the limits by hand or switched account): it sends the same resume prompt the timer would have, resets the guard and drops the old window's reading; with no saved pause it falls back to the newest `.claude/aar/*/AAR.md` of the folder. While the guard is active the user's other prompts are not sent to the model: they are saved verbatim and written (statically, no model call) onto the top of the AAR, so the resume handles them first.

Install: `claude plugin marketplace add ~/Workspace/personal/claude-mods` then `claude plugin install usage-eta@claude-mods`.

Setup: run `/usage-eta-setup` once (and after updates) to add the marked agent-coordination rules to `~/.claude/CLAUDE.md` (dated backup, idempotent, `--remove` undoes it), so every agent estimates tasks, names subagent types and reports data the estimator learns from.

Learning: the estimator learns from finished todos, from every finished main-loop turn (pace and token rate) and from every finished agent run (per subagent type), plus the 5h-percent-per-token rate from each limit reading. It leaves the "still learning" state after 5 samples of any of the first three and 3 rate readings, and keeps refining afterwards. With no todo list, the running turn is forecast from the learned turn length once 5 turns are known. The pane shows how many of each it learned from.

`/eta pause` is for when you have to step away (leaving, a restart, the network going down) and no limit is near: running work finishes and checkpoints, the AAR is written, then the session holds, with the same held-prompt handling as the guard. Unlike a limit pause it never resumes on its own, not at the 5h reset and not when a fresh low reading arrives, and it survives a restart of Claude Code. `/eta resume` continues from the AAR when you are back (it also works on a limit pause). Run `/eta pause` during a limit pause to make it wait for `/eta resume` instead of the reset.

Subcommands autocomplete: type `/eta ` and the typeahead offers `pause`, `resume`, `bypass <prompt>`, `override` and `guard on` (and `off`/`on` after `override`/`guard`).

Agents at any depth: the guard tracks every agent of the session however deeply they nest, from the events of each agent's own loop together with the agent list (which misses workflow agents and forks, and marks a parent waiting on its child as `waiting`). While the guard is active no agent starts at any depth, an agent that keeps calling tools after the checkpoint request is stopped, and past the drain limit every remaining agent turn is aborted, deepest first, the main loop last. The SDK has no per-agent stop call, so a stop is a refused tool call or an aborted turn.
