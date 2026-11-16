/**
 * Limit guard: when the 5h window is nearly spent and the remaining work will
 * not fit, write an AAR (after-action report), stop, and resume from the AAR
 * after the reset. A long wait (the prompt cache lives about an hour) clears
 * the session first, so the resume reads the AAR instead of a cold cache.
 */

/** Used percent of the 5h window at which the guard starts to look. */
export const TRIGGER_USED = 95
/** Used + estimated percent that, once exceeded, trips the guard. */
export const TRIGGER_EST = 98
/** Waits longer than this (minutes) clear the session: the cache will be cold. */
export const COLD_MIN = 40
/** Seconds past the reset before resuming, so the new window has registered. */
export const RESUME_SLACK_MS = 60_000

export const MARKER = '[usage-eta:aar]'
export const RESUME_MARKER = '[usage-eta:resume]'

export type Phase = 'idle' | 'writing' | 'waiting'

export type Pending = {
  aar: string
  cwd: string
  resumeAt: number
  /** True when the session was cleared, so the resume starts from the AAR alone. */
  cleared: boolean
  oldSession: string
}

export const shouldTrigger = (usedPct: number | undefined, pctNeeded: number): boolean =>
  usedPct !== undefined && usedPct >= TRIGGER_USED && usedPct + pctNeeded > TRIGGER_EST

export function planResume(now: number, resetsAt: string | undefined) {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  const resetMs = Number.isFinite(at) ? at : now + 5 * 3600_000
  return {
    resumeAt: resetMs + RESUME_SLACK_MS,
    waitMin: Math.max(0, (resetMs - now) / 60000),
    clear: (resetMs - now) / 60000 > COLD_MIN,
  }
}

export const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19)

export const aarPath = (cwd: string, ms: number) => `${cwd}/.claude/aar/AAR-${stamp(ms)}.md`

export const aarPrompt = (path: string, usedPct: number, estPct: number, resetIn: string) =>
  `${MARKER} The 5h usage limit is at ${usedPct.toFixed(0)}% and the work left is estimated at ` +
  `${estPct.toFixed(0)}% total, so it will not fit before the reset (in ${resetIn}). Stop all other work now ` +
  `and write an AAR (after-action report) to ${path} (create the folder if missing). It must let a fresh ` +
  'session with no memory of this one continue seamlessly. Sections: Goal and the user\'s exact asks; ' +
  'Done (with file paths and commit hashes); In progress (exact state, what was half-finished); Next steps ' +
  '(ordered, concrete, with commands); Decisions and why; Constraints and user rules in force; Gotchas, ' +
  'failing tests and open questions; Files and URLs to re-read first. Be dense, no filler. When the file is ' +
  'written reply with one line only: "AAR written" and the path. Do not start any other work.'

export const resumePrompt = (path: string, cleared: boolean) =>
  `${RESUME_MARKER} The usage window has reset. ` +
  (cleared ? 'This is a fresh session: you have no memory of the earlier one. ' : '') +
  `Read the AAR at ${path} in full, restore its plan as your task list, and continue from "Next steps". ` +
  'Re-read only the files the AAR names. Do not redo finished work. If something in the AAR is ' +
  'ambiguous, check the repo state before asking.'

export const purgeScript =
  'd="$HOME/archive/_review/$(date +%F)/sessions"; mkdir -p "$d"; ' +
  'for f in $(find "$HOME/.claude/projects" -name "$1.jsonl" 2>/dev/null); do ' +
  'mv "$f" "$d/" && echo "$(date -Is)\t$f\tsuperseded by AAR resume\t$2" >> "$d/MANIFEST.txt"; done'

export const storeKey = (cwd: string) => `resume:${cwd}`
