---
name: runway-setup
description: Install or update the runway rules in the system-wide ~/.claude/CLAUDE.md so every agent estimates tasks, names subagent types and reports to the runway plugin. Use when the user runs /runway-setup, asks to set up or update runway in CLAUDE.md, or wants to remove it.
---

# runway setup

Adds (or updates in place) one marked block in `~/.claude/CLAUDE.md` with the rules agents must follow so the runway plugin gets data to track and learn from. The script is idempotent, keeps a dated backup (`CLAUDE.md.bak-<date>`) and only touches the text between its two marker lines.

1. Preview: `python3 "${CLAUDE_PLUGIN_ROOT}/skills/runway-setup/setup.py" --dry-run`
2. Apply: `python3 "${CLAUDE_PLUGIN_ROOT}/skills/runway-setup/setup.py"` (the file is protected by the Bash sandbox: run it with the sandbox disabled if it fails with a permission error).
3. Remove: add `--remove`. Use `--file PATH` for another CLAUDE.md.
4. Tell the user what changed (added, updated or already current) and that new sessions pick the block up; running sessions need a restart.

Edit the rules in `claude-md-block.md` next to the script, then run the skill again to update.
