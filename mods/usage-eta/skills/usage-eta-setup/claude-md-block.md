## usage-eta: task tracking and estimation (agents, follow this)

The usage-eta plugin tracks tasks, agent runs and the 5h/weekly limit, and learns from what you report. It can only learn from data you give it:

- Keep a task list for any work of more than one step (TodoWrite, TaskCreate/TaskUpdate or update_plan). End every item with an honest time estimate in minutes, like "Write the parser (~12m)" or "(~1.5h)". Keep an item's wording unchanged between updates so progress is matched; mark it completed as soon as it is done, never in a batch at the end.
- Delegate to subagents with the Agent tool, always with a specific `subagent_type` and a short `description` of the step. Do the work of one step per agent, so each run is timed and learned per type. In a multi-agent flow (EGM, parallel reviewers) give each step its own agent and list each step in the task list.
- When the guard says the 5h limit is nearly spent, start no new work: finish what runs, write the checkpoint or AAR it asks for, and stop. Do not retry or work around it. The person can use /eta, /eta pause, /eta resume, /eta override or /eta bypass.
- Report real outcomes: if a step was skipped, failed or not verified, say so in the task text or the final message, so the estimate is corrected by what actually happened.
