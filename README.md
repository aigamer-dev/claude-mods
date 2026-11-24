# claude-mods

Personal mods for Claude Code (desktop and CLI).

## usage-eta
Shows the 5-hour and weekly usage limits, a task tracker (including EGM subagent steps), and an ETA, token and fits-in-the-5h-window forecast. The estimator calibrates itself from each finished task. Open it with `/eta`. `/eta override` lifts the limit guard in every session until the 5h window resets; `/eta guard on` turns it back on.

Install: `claude plugin marketplace add ~/dev/personal/claude-mods` then `claude plugin install usage-eta@claude-mods`.
