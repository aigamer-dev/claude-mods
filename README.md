# claude-mods

Personal mods for Claude Code (desktop and CLI).

## usage-eta
Shows the 5-hour and weekly usage limits, a task tracker (including EGM subagent steps), and an ETA, token and fits-in-the-5h-window forecast. The estimator calibrates itself from each finished task. Open it with `/eta`. `/eta override` lifts the limit guard in every session until the 5h window resets; `/eta guard on` turns it back on. `/eta bypass <prompt>` runs one prompt with the guard lifted for that turn only. `/eta resume` continues from the AAR right now, without waiting for the reset (use it after you reset the limits by hand or switched account): it sends the same resume prompt the timer would have, resets the guard and drops the old window's reading; with no saved pause it falls back to the newest `.claude/aar/*/AAR.md` of the folder. While the guard is active the user's other prompts are not sent to the model: they are saved verbatim and written (statically, no model call) onto the top of the AAR, so the resume handles them first.

Install: `claude plugin marketplace add ~/dev/personal/claude-mods` then `claude plugin install usage-eta@claude-mods`.
