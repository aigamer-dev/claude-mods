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

/**
 * idle -> draining (no new work starts, running calls and agents finish and
 * checkpoint) -> writing (the AAR turn) -> waiting (paused until the reset).
 */
export type Phase = 'idle' | 'draining' | 'writing' | 'waiting'

/** Longest the guard waits for running agents to checkpoint before it writes the AAR. */
export const DRAIN_MAX_MS = 5 * 60_000
/** A session whose heartbeat is older than this is treated as gone. */
export const LIVE_MS = 90_000
/** Default cost of one thread's AAR, in percent of the 5h window (learned later). */
export const AAR_COST_PCT = 1.5
/** Headroom factor on the AAR cost: a long thread writes more than the average. */
export const AAR_SAFETY = 1.5
/** Minutes of work that may still run while the guard drains. */
export const DRAIN_MIN = 3

export const STATE_KEY = 'guard:cost'
export const TRIP_KEY = 'guard:trip'
export const liveKey = (sessionId: string) => `live:${sessionId}`

export type Live = { t: number; threads: number; cwd: string }
export type Trip = { resetsAt: string; at: number }

/** Threads writing an AAR at once = the live sessions' threads, this one's included. */
export function countThreads(live: readonly Live[], now: number, own: number): number {
  const others = live.filter(l => now - l.t <= LIVE_MS).reduce((n, l) => n + l.threads, 0)
  return Math.max(1, own + others)
}

/**
 * The guard's thresholds. With one thread they are the plain 95% used / 98%
 * estimated; each extra thread must write an AAR from the same window, so the
 * reserve grows with the thread count and the guard trips earlier. `rate` is
 * the recent burn (percent per minute): work that keeps running while the
 * guard drains eats into the headroom too.
 */
export function thresholds(threads: number, aarCostPct: number, rate = 0) {
  const reserve = threads * aarCostPct * AAR_SAFETY + 1 + Math.max(0, rate) * DRAIN_MIN
  return {
    reserve,
    used: Math.min(TRIGGER_USED, 100 - reserve),
    est: Math.min(TRIGGER_EST, 100 - reserve / 2),
  }
}

export const shouldTripAt = (
  usedPct: number | undefined,
  pctNeeded: number,
  th: { used: number; est: number },
): boolean => usedPct !== undefined && usedPct >= th.used && usedPct + pctNeeded > th.est

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TaskOutput', 'BashOutput', 'TaskList', 'TaskGet', 'ToolSearch'])
const READ_BASH = /^\s*(git\s+(status|log|diff|branch|stash\s+list|show)|ls|pwd|cat|head|tail|jobs|ps|wc)\b/

/** What a tool may do while the guard is draining or writing; the rest is refused. */
export function toolAllowed(
  phase: Phase,
  tool: string,
  input: { file_path?: string; command?: string },
  aarDir: string,
): boolean {
  if (phase === 'idle') return true
  if (READ_TOOLS.has(tool)) return true
  if (phase === 'waiting') return false
  if ((tool === 'Write' || tool === 'Edit') && typeof input.file_path === 'string') {
    return input.file_path.startsWith(`${aarDir}/`) && !input.file_path.includes('..')
  }
  if (tool === 'Bash' && typeof input.command === 'string') {
    return READ_BASH.test(input.command) && !/[;&|><`$]/.test(input.command)
  }
  return false
}

export const denyText = (phase: Phase, isAgent: boolean, aarDir: string, id: string) =>
  phase === 'waiting'
    ? 'Usage guard: paused until the 5h window resets. Do nothing; reply with one word.'
    : isAgent
      ? `Usage guard: the 5h limit is nearly spent. Start nothing new. Write your checkpoint now with Write to ` +
        `${aarDir}/agent-${id.slice(0, 8)}.md (task, done, in progress, next steps, files touched, background ` +
        'work you started and where its output goes), then reply with only that path. Reading is still allowed.'
      : 'Usage guard: the 5h limit is nearly spent. Start no new work and spawn no agents. Running work is ' +
        'allowed to finish and checkpoint; end your turn now with one short line. An AAR request follows.'

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

export const aarPath = (cwd: string, ms: number) => `${cwd}/.claude/aar/${stamp(ms)}/AAR.md`

export const aarPrompt = (path: string, usedPct: number, estPct: number, resetIn: string, threads: number) =>
  `${MARKER} The 5h usage limit is at ${usedPct.toFixed(0)}% and the work left is estimated at ` +
  `${estPct.toFixed(0)}% total (${threads} thread(s) are writing AARs from this window), so it will not fit ` +
  `before the reset (in ${resetIn}). Stop all other work now and write an AAR (after-action report) to ${path} ` +
  `(create the folder if missing). First read every agent-*.md checkpoint in ${path.replace(/\/[^/]*$/, '')} ` +
  'and fold each into the AAR. List every background shell or agent still running (id, purpose, where its ' +
  'output lands) and every uncommitted change (git status) so nothing is lost. Keep it compact: your budget ' +
  'is a few thousand tokens. It must let a fresh ' +
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

export const aarDirOf = (aar: string) => aar.replace(/\/[^/]*$/, '')
