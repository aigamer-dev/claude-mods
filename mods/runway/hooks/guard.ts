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

/** resumeAt of a pause made with /eta pause: no timer ends it, only /eta resume. */
export const MANUAL_RESUME_AT = Number.MAX_SAFE_INTEGER

export const MARKER = '[runway:aar]'
export const RESUME_MARKER = '[runway:resume]'

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
/**
 * A fresh 5h reading under this percent means a new window (a reset, or another
 * account): a pause or a shared trip kept from the old one no longer applies.
 */
export const RELEASE_BELOW_PCT = 50

/** The guard never trips below this used percent (it must stay above RELEASE_BELOW_PCT). */
export const MIN_TRIP_USED = RELEASE_BELOW_PCT + 10
/** Longest the AAR turn may run before the guard stops waiting for its marker. */
export const WRITE_MAX_MS = 10 * 60_000

/** True when a fresh 5h reading shows the window that tripped the guard is gone. */
export const windowFresh = (usedPct: number | undefined): boolean =>
  usedPct !== undefined && usedPct < RELEASE_BELOW_PCT

export const STATE_KEY = 'guard:cost'
export const TRIP_KEY = 'guard:trip'
/** Set by /eta override: every session keeps the guard off until `until`. */
export const HOLD_KEY = 'guard:hold'
/** How long the guard stays off after an AAR turn that wrote no file (no retry loop). */
/** A guard transition that has not finished after this long no longer blocks the others. */
export const LOCK_MAX_MS = 30_000
export const AAR_RETRY_MS = 10 * 60_000
export const liveKey = (sessionId: string) => `live:${sessionId}`

/** `cycle` is the AAR path of the guard cycle this session is in (it survives a /clear). */
export type Live = { t: number; threads: number; cwd: string; cycle?: string }
export type Trip = { resetsAt: string; at: number }
export type Hold = { until: number; at: number }

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
  // Floors keep the trip point above RELEASE_BELOW_PCT: a trip below it would read as a fresh
  // window, release at once and trip again on every reading.
  const used = Math.max(MIN_TRIP_USED, Math.min(TRIGGER_USED, 100 - reserve))
  return {
    reserve,
    used,
    est: Math.max(used + 3, Math.min(TRIGGER_EST, 100 - reserve / 2)),
  }
}

export const shouldTripAt = (
  usedPct: number | undefined,
  pctNeeded: number,
  th: { used: number; est: number },
): boolean => usedPct !== undefined && usedPct >= th.used && usedPct + pctNeeded > th.est

/**
 * A path in one comparable form: forward slashes, `.`/`..` resolved, doubled
 * slashes collapsed, Git Bash (`/c/x`) and WSL (`/mnt/c/x`) drives turned into
 * `c:/x`, and lower-cased when it is a Windows path (drive letter, or a
 * backslash in the original), whose file system ignores case.
 */
export function normPath(p: string): string {
  const raw = p.trim()
  const s = raw.replace(/\\/g, '/').replace(/^\/mnt\/([a-z])(?=\/|$)/i, '/$1').replace(/^\/([a-z])(?=\/|$)/i, '$1:')
  const unc = s.startsWith('//')
  const parts: string[] = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  const lead = /^[a-z]:$/i.test(parts[0] ?? '') ? '' : unc ? '//' : s.startsWith('/') ? '/' : ''
  const out = lead + parts.join('/')
  return /^[a-z]:/i.test(out) || raw.includes('\\') ? out.toLowerCase() : out
}

/** True when `file` is inside `dir` (after both are normalised). */
export const insideDir = (file: string, dir: string): boolean => {
  const d = normPath(dir)
  return d !== '' && normPath(file).startsWith(`${d}/`)
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TaskOutput', 'BashOutput', 'TaskList', 'TaskGet', 'ToolSearch'])
const GIT_READ = String.raw`git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+(?:status|log|diff|branch|stash\s+list|show)`
const READ_BASH = new RegExp(String.raw`^\s*(?:${GIT_READ}|ls|pwd|cat|head|tail|jobs|ps|wc|dir)\b`)
const READ_PS = new RegExp(
  String.raw`^\s*(?:${GIT_READ}|Get-ChildItem|Get-Content|Get-Location|Test-Path|Select-String|gci|gc|ls|dir|cat|pwd)\b`,
  'i',
)
const SHELL_META = /[;&|><`$\r\n{}]/
/** Anything outside printable ASCII (smart quotes and the like) can hide an option from the checks. */
const NON_ASCII = /[^\x20-\x7e]/
/** `git branch` may only list; any other argument can delete or rename a branch. */
const GIT_BRANCH_ARGS = /^(?:\s+(?:-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--verbose))*\s*$/
/**
 * Threat model: this allowlist steers a model that is honest but eager, so it does not start new
 * work while the 5h limit is nearly spent. It is not a sandbox against a hostile one. The cheap
 * holes that need no cleverness are shut (below); do not rely on it to contain adversarial input.
 *
 * Extra checks for a git command that matched the read-only list: no `-c` (it runs configured
 * commands), no `--ou...` (`--output` writes a file, and git takes abbreviations), no
 * `--no-index`, `--ext-diff` or `--textconv` (they run configured programs), no quotes or
 * backslashes outside the `-C <path>` (they hide options from these checks), a `-C <path>` that
 * is not inside the AAR folder (a repository the model wrote there could name a hook in its own
 * config), and `branch` only lists. Case-sensitive on purpose.
 */
function gitReadSafe(cmd: string, aarDir: string): boolean {
  if (!/\bgit\b/i.test(cmd)) return true
  const c = /(\bgit\s+)-C\s+("[^"]*"|'[^']*'|\S+)/.exec(cmd)
  if (c) {
    const target = unquote(c[2] ?? '')
    // A relative path cannot be placed against the AAR folder here: refuse it (use an absolute one).
    if (!/^(?:\/|[a-z]:[\\/])/i.test(target)) return false
    if (aarDir && insideDir(`${target}/x`, aarDir)) return false
  }
  const rest = cmd.replace(/(\bgit\s+)-C\s+(?:"[^"]*"|'[^']*'|\S+)/, '$1')
  if (/(^|\s)-c(\s|=|$)/.test(rest) || /--ou/.test(rest) || /["'\\]/.test(rest)) return false
  if (/--(?:no-index|ext-diff|textconv)/.test(rest)) return false
  const m = /\bgit\s+branch\b(.*)$/i.exec(rest)
  return !m || GIT_BRANCH_ARGS.test(m[1] ?? '')
}

const unquote = (x: string) => x.replace(/^["']|["']$/g, '')

/** `mkdir [-p] <the AAR folder>` and nothing else, in a POSIX or PowerShell form. */
function isAarMkdir(cmd: string, aarDir: string): boolean {
  if (SHELL_META.test(cmd)) return false
  const m =
    /^\s*mkdir\s+(?:-p\s+)?("[^"]+"|'[^']+'|\S+)\s*$/i.exec(cmd) ??
    /^\s*New-Item\s+(?:-ItemType\s+Directory\s+|-Force\s+)*(?:-Path\s+)?("[^"]+"|'[^']+'|\S+)(?:\s+-ItemType\s+Directory|\s+-Force)*\s*$/i.exec(cmd)
  if (!m) return false
  const target = unquote(m[1] ?? "")
  return normPath(target) === normPath(aarDir) || insideDir(`${target}/x`, aarDir)
}

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
    // Never into a `.git` folder: a repository planted in the AAR folder could carry a hook in its config.
    // ...nor a file named HEAD or config: a bare repository needs no `.git` folder.
    return (
      insideDir(input.file_path, aarDir) &&
      !/(^|[\\/])\.git([\\/]|$)/i.test(input.file_path) &&
      !/(^|[\\/])(?:HEAD|config)$/i.test(input.file_path)
    )
  }
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') {
    const cmd = input.command
    if (isAarMkdir(cmd, aarDir)) return true
    return (
      (tool === 'Bash' ? READ_BASH : READ_PS).test(cmd) &&
      !SHELL_META.test(cmd) &&
      !NON_ASCII.test(cmd) &&
      !(tool === 'PowerShell' && /[()]/.test(cmd)) &&
      gitReadSafe(cmd, aarDir)
    )
  }
  return false
}

export const denyText = (phase: Phase, isAgent: boolean, aarDir: string, id: string, manual = false) => {
  const why = manual ? 'the person paused this session with /eta pause' : 'the 5h limit is nearly spent'
  return phase === 'waiting'
    ? manual
      ? 'Usage guard: the person paused this session with /eta pause; it stays paused until they run /eta resume. ' +
        'Do nothing; reply with one word.'
      : 'Usage guard: paused until the 5h window resets (the person can run /eta resume to continue from the AAR now, or /eta override to lift it). ' +
        'Do nothing; reply with one word.'
    : isAgent
      ? `Usage guard: ${why}. Start nothing new. Write your checkpoint now with Write to ` +
        `${aarDir}/agent-${id.slice(0, 8)}.md (task, done, in progress, next steps, files touched, background ` +
        'work you started and where its output goes), then reply with only that path. Reading is still allowed.'
      : `Usage guard: ${why}. Start no new work and spawn no agents. Running work is ` +
        'allowed to finish and checkpoint; end your turn now with one short line. An AAR request follows. ' +
        `Only Write/Edit inside ${aarDir}/ is allowed, as an absolute path.`
}

export type Pending = {
  aar: string
  cwd: string
  resumeAt: number
  /** True when the session was cleared, so the resume starts from the AAR alone. */
  cleared: boolean
  oldSession: string
  /** Made with /eta pause: resumes only on /eta resume, whatever the 5h window does. */
  manual?: boolean
  /** The session that holds this pause now: another session adopting it takes the claim, and the old holder steps down. */
  claimedBy?: string
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

/** `tag` (a session id prefix) keeps two sessions that trip in the same second on different AARs. */
export const aarPath = (cwd: string, ms: number, tag = '') =>
  `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/.claude/aar/${stamp(ms)}${tag ? `-${tag}` : ''}/AAR.md`

export const aarPrompt = (
  path: string,
  usedPct: number,
  estPct: number,
  resetIn: string,
  threads: number,
  manual = false,
) =>
  (manual
    ? `${MARKER} The person is pausing this session (they are leaving, or a restart or network outage is coming) ` +
      'and will resume later with /eta resume. '
    : `${MARKER} The 5h usage limit is at ${usedPct.toFixed(0)}% and the work left is estimated at ` +
      `${estPct.toFixed(0)}% total (${threads} thread(s) are writing AARs from this window), so it will not fit ` +
      `before the reset (in ${resetIn}). `) +
  `Stop all other work now and write an AAR (after-action report) to ${path} ` +
  `(the Write tool creates the folder: do not run mkdir; use exactly this absolute path). First read every agent-*.md checkpoint in ${aarDirOf(path)} ` +
  'and fold each into the AAR. List every background shell or agent still running (id, purpose, where its ' +
  'output lands) and every uncommitted change (git status) so nothing is lost. Keep it compact: your budget ' +
  'is a few thousand tokens. It must let a fresh ' +
  'session with no memory of this one continue seamlessly. Sections: Goal and the user\'s exact asks; ' +
  'Done (with file paths and commit hashes); In progress (exact state, what was half-finished); Next steps ' +
  '(ordered, concrete, with commands); Decisions and why; Constraints and user rules in force; Gotchas, ' +
  'failing tests and open questions; Files and URLs to re-read first. Be dense, no filler. When the file is ' +
  'written reply with one line only: "AAR written" and the path. Do not start any other work.'

export const resumePrompt = (path: string, cleared: boolean, hasCmds = false, manual = false, inline = '') =>
  (inline
    ? `${RESUME_MARKER} The held prompts could not be written into the AAR; they are listed here instead and ` +
      `must be handled first:\n\n${inline}\n\n`
    : '') +
  `${RESUME_MARKER} ` +
  (manual ? 'The person paused this session and is back now. ' : 'The usage window has reset. ') +
  (cleared ? 'This is a fresh session: you have no memory of the earlier one. ' : '') +
  (hasCmds
    ? 'The AAR opens with commands the user gave while the usage guard was active and that were held: reason ' +
      'about them first, fold them into the plan, then carry them out. '
    : '') +
  `Read the AAR at ${path} in full, restore its plan as your task list, and continue from "Next steps". ` +
  'Re-read only the files the AAR names. Do not redo finished work. If something in the AAR is ' +
  'ambiguous, check the repo state before asking.'

export const purgeScript =
  'd="$HOME/archive/_review/$(date +%F)/sessions"; mkdir -p "$d"; ' +
  'for f in $(find "$HOME/.claude/projects" -name "$1.jsonl" 2>/dev/null); do ' +
  'mv "$f" "$d/" && echo "$(date -Is)\t$f\tsuperseded by AAR resume\t$2" >> "$d/MANIFEST.txt"; done'

/** One saved pause per guard cycle, keyed by the cycle's unique AAR path. */
export const RESUME_PREFIX = 'resume:'
export const storeKey = (aar: string) => `${RESUME_PREFIX}${aar}`

export const aarDirOf = (aar: string) => aar.replace(/[\\/][^\\/]*$/, '')

/** The mod's own name, as it shows in a prompt's origin when the mod submits one. */
export const PLUGIN_NAME = 'runway'

/**
 * A prompt the guard holds back: what the user typed after the guard tripped.
 * `bypass` ones were run under /eta bypass (so already done, but after the AAR
 * was written); the rest were never run.
 */
export type Cmd = { t: number; text: string; kind: 'held' | 'bypass' }
/** Held prompts belong to one guard cycle (its AAR path), so cycles and sessions never mix. */
export const cmdsKey = (aar: string) => `guard:cmds:${aar}`

/**
 * True when a saved pause may be picked up by this session: no other live session
 * is in that cycle (this session's own old heartbeat does not count). The cycle id is the AAR path, which a /clear does not change.
 */
export const mayAdopt = (
  rec: { aar: string; oldSession: string },
  ownId: string,
  live: readonly { id: string; t: number; cycle?: string }[],
  now: number,
): boolean => !live.some(l => l.id !== ownId && l.cycle === rec.aar && now - l.t <= LIVE_MS)

export const CMD_BEGIN = '<!-- runway:commands -->'
export const CMD_END = '<!-- /runway:commands -->'

/** A held prompt as one blockquoted list item, whatever lines it has. */
const quote = (text: string) =>
  text
    .trim()
    .split(/\r?\n/)
    .map(l => `   > ${l}`)
    .join('\n')

/**
 * The block placed at the very top of the AAR, written by the mod itself (no
 * model call), so the resume reads the user's late commands before anything else.
 */
export function commandsBlock(cmds: readonly Cmd[]): string {
  const held = cmds.filter(c => c.kind === 'held').length
  const items = cmds
    .map((c, i) => {
      const when = new Date(c.t).toISOString().replace(/\.\d+Z$/, 'Z')
      const note =
        c.kind === 'held'
          ? 'NOT RUN: held by the usage guard'
          : 'ran under /eta bypass after this AAR was written: its effects may be missing from the sections below'
      return `${i + 1}. [${when}] ${note}\n${quote(c.text)}`
    })
    .join('\n\n')
  return (
    `${CMD_BEGIN}\n` +
    `# USER COMMANDS RECEIVED AFTER THE USAGE GUARD TRIPPED: ADDRESS FIRST\n\n` +
    `${held} command(s) were held and never run; the user typed them verbatim while the 5h limit guard was ` +
    'active. Saved by the runway mod, not written by the previous session. Before the plan below, read ' +
    'each one, reason about how it changes, adds to or reorders the "Next steps", say so in your first ' +
    'reply, then carry them out.\n\n' +
    `${items}\n` +
    `${CMD_END}\n\n`
  )
}

/** The command-block markers written while this mod was still called usage-eta: an AAR may carry them. */
const LEGACY_CMD_BEGIN = '<!-- usage-eta:commands -->'
const LEGACY_CMD_END = '<!-- /usage-eta:commands -->'

const stripBlock = (text: string, begin: string, end: string) => {
  const a = text.indexOf(begin)
  const b = text.indexOf(end)
  return a >= 0 && b > a ? text.slice(0, a) + text.slice(b + end.length).replace(/^\s*\n/, '') : text
}

/** The AAR text with the commands block on top (an earlier block replaced); unchanged for none. */
export function withCommands(aar: string, cmds: readonly Cmd[]): string {
  if (cmds.length === 0) return aar
  const rest = stripBlock(stripBlock(aar, CMD_BEGIN, CMD_END), LEGACY_CMD_BEGIN, LEGACY_CMD_END)
  return commandsBlock(cmds) + rest
}

/** The people's own prompts (typed, bridged, channelled), not another plugin's or a notification. */
const USER_KINDS = new Set(['composer', 'bridge', 'channel', 'slack-ping', 'unclassified'])

/** True when a prompt is one the guard must hold: the user's, and not this mod's own submission. */
export function isHeldPrompt(
  e: { text: string; origin?: { kind: string; name?: string }; command?: unknown; isMeta?: boolean },
  bypassText?: string,
): boolean {
  if (e.command || e.isMeta) return false
  if (e.text.includes(MARKER) || e.text.includes(RESUME_MARKER)) return false
  if (bypassText !== undefined && e.text === bypassText) return false
  const k = e.origin?.kind
  if (k === 'plugin') return false
  return k === undefined || USER_KINDS.has(k)
}

/** The /eta subcommands the typeahead offers, in the order drawn. A trailing space is kept for one that takes text. */
const ETA_SUBS = [
  { text: 'pause', description: 'save an AAR and stay paused until /eta resume' },
  { text: 'resume', description: 'continue from the saved AAR now' },
  { text: 'bypass ', label: 'bypass <prompt>', description: 'run one prompt with the limit guard lifted' },
  { text: 'override', description: 'lift the limit guard for a while' },
  { text: 'guard on', description: 'turn the limit guard back on after an override' },
] as const
/** The word that may follow a two-word subcommand. */
const ETA_SECOND: Record<string, { text: string; description: string }> = {
  override: { text: 'off', description: 'turn the limit guard back on' },
  guard: { text: 'on', description: 'turn the limit guard back on' },
}

/**
 * Typeahead rows for `/eta <word>`: the subcommands (and the word after `override` or `guard`).
 * `text` is the whole draft, `start` where the token at the cursor begins and `token` that token.
 * Nothing is offered for the prompt after `bypass`, or anywhere but the first word after /eta.
 */
export function etaCompletions(text: string, start: number, token: string): { text: string; label?: string; description: string }[] {
  const before = text.slice(0, start)
  const word = token.toLowerCase()
  const second = /^\s*\/eta\s+(override|guard)\s+$/i.exec(before)
  if (second) {
    const row = ETA_SECOND[(second[1] ?? '').toLowerCase()]
    return row && row.text.startsWith(word) ? [row] : []
  }
  if (!/^\s*\/eta\s+$/i.test(before)) return []
  return ETA_SUBS.filter(r => r.text.trim().startsWith(word) || (r.text === 'guard on' && 'guard'.startsWith(word))).map(r =>
    r.text === 'guard on' ? { text: 'guard ', label: 'guard on', description: r.description } : { ...r },
  )
}
