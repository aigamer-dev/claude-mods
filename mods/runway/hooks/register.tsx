import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EgmRun, Task, Usage } from '../types'
import {
  barParts,
  blank,
  correction,
  estTaskMin,
  expectedAgents,
  fmtMin,
  fmtTok,
  forecast,
  learnAgent,
  learnEgm,
  learnRate,
  learnTask,
  learnTurn,
  syncTodos,
  agentMinOf,
  applyTool,
  TRACKED,
} from './estimator'
import type { Todo } from './estimator'
import {
  AAR_COST_PCT,
  AAR_RETRY_MS,
  DRAIN_MAX_MS,
  HOLD_KEY,
  LIVE_MS,
  LOCK_MAX_MS,
  MANUAL_RESUME_AT,
  MARKER,
  RESUME_MARKER,
  RESUME_PREFIX,
  STATE_KEY,
  TRIP_KEY,
  WRITE_MAX_MS,
  aarDirOf,
  aarPath,
  aarPrompt,
  cmdsKey,
  countThreads,
  denyText,
  etaCompletions,
  isHeldPrompt,
  liveKey,
  mayAdopt,
  planResume,
  purgeScript,
  resumePrompt,
  shouldTripAt,
  storeKey,
  thresholds,
  toolAllowed,
  windowFresh,
  withCommands,
  commandsBlock,
} from './guard'
import type { Cmd, Hold, Live, Pending, Phase, Trip } from './guard'
import type { Model } from './estimator'
import { abortOrder, live as liveAgents, merge as mergeAgents, newCycle, noteDenied, noteEnd, noteSeen, noteSpawn } from './agents'
import type { Tree } from './agents'

const PANE = 'runway'
const tasks = atom({ plugin: 'runway', key: 'tasks' } as const, [], {
  shape: 'tasks-1',
})
const egm = atom({ plugin: 'runway', key: 'egm' } as const, null, {
  shape: 'egm-2',
})
const usage = atom({ plugin: 'runway', key: 'usage' } as const, { tokens: 0, usd: 0 }, {
  shape: 'usage-1',
})

const ETA_RULE = {
  id: 'runway:eta',
  scope: 'session',
  text:
    'When you keep a task list (TodoWrite, TaskCreate, or a plan tool), end every item\'s ' +
    'text (the todo content, task subject or plan step) with your honest time estimate in ' +
    'minutes, like "Write the parser (~12m)" or "(~1.5h)". The usage tracker compares it ' +
    'with the real time and calibrates future estimates. Keep item wording unchanged ' +
    'between updates so progress is matched.',
} as const

const effective = (u: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}) =>
  u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens

const skillName = (s: string) => s.replace(/^egm:/, '')

/** Limit-guard state: idle, draining, writing the AAR, or waiting for the reset. */
const G = {
  phase: 'idle' as Phase,
  /** The main loop's running turn, so the guard can stop it as a last resort. */
  turnId: undefined as string | undefined,
  /** True while the main loop is in a turn. */
  running: false,
  /** True once the AAR turn this guard asked for has started. */
  armed: false,
  aar: '',
  /** True for a pause the person asked for (/eta pause): no limit, no timer, only /eta resume ends it. */
  manual: false,
  used: 0,
  est: 0,
  threads: 1,
  drainAt: 0,
  /** When the AAR turn was requested (a stuck writing phase ends WRITE_MAX_MS later). */
  writeAt: 0,
  /** True once a turn has run in this process (a late adoption of a saved pause is then off). */
  sawTurn: false,
  /** True when the trip started from a real 5h reading (else the AAR cost is not learned). */
  baseline: false,
  resetsAt: undefined as string | undefined,
  pending: undefined as Pending | undefined,
  /** The guard stays off until this time; mirrored in the store (HOLD_KEY) for every session. */
  holdUntil: 0,
  /** Set by /eta bypass: the one prompt (and its turn) that runs with the guard lifted. */
  bypass: undefined as { text: string; at: number; turnId?: string } | undefined,
  /** Recent five-hour readings, for the burn rate. */
  readings: [] as { t: number; pct: number }[],
}

const S = {
  model: blank() as Model,
  loaded: false,
  mark: { t: 0, tok: 0 },
  tokSincePct: 0,
  /** Percent of the 5h window gained since the rate was last learned. */
  pctSince: 0,
  lastPct: undefined as number | undefined,
  todos: [] as Todo[],
  /** The main-loop turn running now: when it began and what the session had spent. */
  turn: undefined as { id: string; t: number; tok: number; skip: boolean } | undefined,
  /** Agent calls already timed (a call reaches both the tool.call and agent.spawn hooks). */
  agentSeen: new Set<string>(),
}

/**
 * Every agent of the session at any depth, from the events of each loop and the
 * list together (agents.ts): the guard counts, drains and stops this tree.
 */
const AG: Tree = new Map()

/** Start of the running main-loop turn, for the forecast when there is no todo list. */
const turnStart = () => (G.running ? S.turn?.t : undefined)

/** Runs guard transitions one at a time: each checks the phase, awaits, then changes it. */
let lock: Promise<unknown> = Promise.resolve()
let after: ((ms: number, cb: () => void) => void) | undefined
/**
 * Bumped when a locked step times out and whenever the guard is released or held off. A step captures it
 * when it starts and returns, before it changes anything, if it moved: a step that outlived its lock (or an
 * /eta override that came meanwhile) must not set the phase, the saved pause or the trip afterwards.
 */
let gen = 0
function serial<T>(fn: () => Promise<T>): Promise<T> {
  let free!: () => void
  const hung = new Promise<void>(res => (free = res))
  let done = false
  // One hung engine call must not freeze every hook and command: the queue moves on LOCK_MAX_MS after
  // the step began (not after it was queued), and the step is fenced off from then on.
  const run = () => {
    after?.(LOCK_MAX_MS, () => {
      if (!done) gen++
      free()
    })
    return fn()
  }
  const r = lock.then(run, run)
  void r.then(
    () => (done = true),
    () => (done = true),
  )
  lock = Promise.race([r.catch(() => undefined), hung])
  return r
}

/** Times one agent run once, whichever hook sees it first, and learns from it. */
async function timeAgent<T extends { deny?: unknown }>(
  $: EngineInterface,
  id: string,
  type: string,
  run: () => Promise<T>,
): Promise<T> {
  const first = id !== '' && !S.agentSeen.has(id)
  if (first) {
    if (S.agentSeen.size > 500) S.agentSeen.clear()
    S.agentSeen.add(id)
  }
  const t0 = await $.clock.now()
  const ran = await run()
  if (first && ran.deny === undefined) {
    const min = ((await $.clock.now()) - t0) / 60000
    await learn($, m => learnAgent(m, type, min)).catch(() => undefined)
  }
  return ran
}

/** The model as the store holds it now (other sessions learn into the same record). */
async function loadModel($: EngineInterface): Promise<Model | undefined> {
  const saved = (await $.store.get('model').catch(() => undefined)) as Model | undefined
  return saved && typeof saved.n === 'number' ? { ...blank(), ...saved } : undefined
}

/**
 * Learns into the shared model. Every session keeps a copy in memory and a long
 * session's copy goes stale, so a plain "write my copy" erased what the other
 * sessions had learned (task samples were wiped by each rate save). Re-read,
 * apply, write.
 */
async function learn($: EngineInterface, fn: (m: Model) => Model) {
  S.model = fn((await loadModel($)) ?? S.model)
  await $.store.set('model', S.model)
}

async function ensure($: EngineInterface) {
  if (S.loaded) return
  S.loaded = true
  const saved = await loadModel($)
  if (saved) S.model = saved
}

/** Pulls in what other sessions learned, so the forecast uses the shared model. */
async function refreshModel($: EngineInterface) {
  const saved = await loadModel($)
  if (saved) S.model = saved
}

/** Keeps the guard off until `until` in every session (what /eta override and a failed AAR set). */
async function setHold($: EngineInterface, until: number) {
  gen++
  G.holdUntil = until
  await $.store.set(HOLD_KEY, { until, at: await $.clock.now() } satisfies Hold)
}

async function clearHold($: EngineInterface) {
  G.holdUntil = 0
  await $.store.delete(HOLD_KEY)
}

/** The prompts held (or bypassed) since the guard tripped in this folder. */
/** A short, path-safe prefix of the session id, so two sessions never share an AAR path. */
const sidTag = async ($: EngineInterface) => (await $.session.id()).replace(/[^A-Za-z0-9]/g, '').slice(0, 8)

/** The guard cycle this session is in: its AAR path, which survives a /clear. */
const cycleId = () => G.pending?.aar ?? G.aar

async function loadCmds($: EngineInterface): Promise<Cmd[]> {
  const id = cycleId()
  if (!id) return []
  const v = (await $.store.get(cmdsKey(id)).catch(() => undefined)) as Cmd[] | undefined
  return Array.isArray(v) ? v : []
}

/** Takes the held prompts out of the store and returns them as a list to show the user. */
async function dropHeld($: EngineInterface): Promise<string> {
  const held = heldList(await loadCmds($))
  const id = cycleId()
  if (id) await $.store.delete(cmdsKey(id)).catch(() => undefined)
  return held
}

/**
 * Writes the held prompts onto the top of the AAR, statically (no model call):
 * the file is read, any earlier block replaced, the new one prepended. A no-op
 * until the AAR exists; finishAar and the resume call it again.
 */
async function flushCmds($: EngineInterface): Promise<boolean> {
  const path = G.pending?.aar ?? G.aar
  const cmds = await loadCmds($)
  if (cmds.length === 0) return true
  if (!path || !(await $.fs.exists(path).catch(() => false))) return false
  try {
    const text = await $.fs.read(path)
    await $.fs.write(path, withCommands(text, cmds))
    return true
  } catch {
    $.ui.toast('Could not add the held prompts to the AAR; they stay saved and are retried')
    return false
  }
}

/** Holds a prompt if the guard is still active once the lock is taken; false when it ended meanwhile. */
const holdPrompt = ($: EngineInterface, text: string) =>
  serial(async () => {
    if (G.phase === 'idle' || !cycleId()) return false
    await addCmdInner($, text, 'held')
    return true
  })

async function addCmdInner($: EngineInterface, text: string, kind: Cmd['kind']) {
  const id = cycleId()
  if (!id) return
  const cmds = await loadCmds($)
  cmds.push({ t: await $.clock.now(), text, kind })
  await $.store.set(cmdsKey(id), cmds)
  await flushCmds($)
}

const addCmd = ($: EngineInterface, text: string, kind: Cmd['kind']) =>
  serial(() => addCmdInner($, text, kind))

/** The time the guard is held until: this session's own, or one another session left in the store. */
async function holdUntil($: EngineInterface): Promise<number> {
  const h = (await $.store.get(HOLD_KEY).catch(() => undefined)) as Hold | undefined
  return Math.max(G.holdUntil, typeof h?.until === 'number' ? h.until : 0)
}

async function summary($: EngineInterface) {
  const [t, g, u] = [await read($, tasks), await read($, egm), await read($, usage)]
  const now = await $.clock.now()
  const f = forecast(t, g, u, S.model, now, turnStart())
  const five = u.fiveHour ? `5h ${u.fiveHour.pct.toFixed(0)}%` : '5h --'
  const wk = u.week ? ` wk ${u.week.pct.toFixed(0)}%` : ''
  const left = f.pending > 0 || (g && !g.doneAt)
  return left
    ? `${five}${wk} · ETA ${fmtMin(f.remainingMin)} · ~${fmtTok(f.tokens)} tok · ${f.fits ? 'fits' : "WON'T FIT"}`
    : `${five}${wk}`
}

async function refreshStatus($: EngineInterface) {
  $.ui.status(await summary($))
}

/** Feeds a todo snapshot to the tracker; learns from tasks that just finished. */
async function ingest($: EngineInterface, todos: readonly Todo[]) {
  await ensure($)
  const now = await $.clock.now()
  const u = await read($, usage)
  const prev = await read($, tasks)
  const { tasks: nextTasks, done } = syncTodos(prev, todos, now, u.tokens, S.mark)
  await update($, tasks, () => nextTasks)
  if (done.length > 0) {
    await learn($, m =>
      done.reduce(
        (acc, t) =>
          learnTask(acc, {
            eta: t.eta,
            actualMin: ((t.doneAt ?? now) - (t.startedAt ?? now)) / 60000,
            tokens: (t.tokDone ?? u.tokens) - (t.tokStart ?? u.tokens),
          }),
        m,
      ),
    )
  }
  S.mark = { t: now, tok: u.tokens }
}

/**
 * Rebuilds the todo list from the transcript. It does not depend on this
 * plugin's tool.call hook running, so a plugin above that answers a task tool
 * by itself, or a call this hook never saw, still reaches the tracker.
 */
async function replay($: EngineInterface): Promise<Todo[]> {
  const rows = await $.session.messages()
  let list: Todo[] = []
  for (const m of rows) {
    for (const use of m.toolUses) {
      if (TRACKED.has(use.tool) && use.isError !== true) {
        list = applyTool(list, use.tool, use.input, use.text)
      }
    }
  }
  return list
}

async function reconcile($: EngineInterface) {
  const list = await replay($)
  if (list.length > 0) {
    S.todos = list
    await ingest($, list)
  }
}

async function startStep($: EngineInterface, id: string, type: string, label: string) {
  const run = await read($, egm)
  if (!run || run.doneAt || run.steps.some(s => s.id === id)) return false
  const step = { id, type, label, startedAt: await $.clock.now() }
  await update($, egm, r => (r ? { ...r, steps: [...r.steps, step] } : r))
  return true
}

async function endStep($: EngineInterface, id: string) {
  const end = await $.clock.now()
  await update($, egm, r =>
    r
      ? { ...r, steps: r.steps.map(s => (s.id === id && !s.doneAt ? { ...s, doneAt: end } : s)) }
      : r,
  )
}

/** Percent of the 5h window burned per minute over the last ten minutes. */
function burnRate(now: number) {
  const r = G.readings.filter(x => now - x.t <= 10 * 60_000)
  if (r.length < 2) return 0
  const [first, last] = [r[0], r[r.length - 1]]
  const mins = (last.t - first.t) / 60000
  return mins > 0.5 ? Math.max(0, (last.pct - first.pct) / mins) : 0
}

/** This session's threads (main + running agents) and every live session's, summed. */
async function liveThreads($: EngineInterface) {
  const now = await $.clock.now()
  // The list misses a workflow's agents and forks, drops an ended agent within seconds, and marks a
  // parent that waits on its child `waiting`: the tree adds what each loop's own events showed, at any depth.
  // A failed list call says nothing about the agents: merging an empty one would mark every listed agent ended.
  const listed = await $.agent.list().then(x => x, () => undefined)
  if (listed) mergeAgents(AG, listed, now)
  const running = liveAgents(AG, now).length
  const own = 1 + running
  const sid = await $.session.id()
  const live: Live[] = []
  for (const k of await $.store.keys().catch(() => [] as string[])) {
    if (!k.startsWith('live:') || k === liveKey(sid)) continue
    const v = (await $.store.get(k)) as Live | undefined
    if (v && now - v.t <= LIVE_MS) live.push(v)
    else await $.store.delete(k)
  }
  return { own, running, n: countThreads(live, now, own), others: live.length }
}

async function heartbeat($: EngineInterface) {
  const [now, sid, cwd, lt] = [await $.clock.now(), await $.session.id(), await $.session.cwd(), await liveThreads($)]
  await $.store.set(liveKey(sid), { t: now, threads: lt.own, cwd, cycle: G.phase === 'idle' ? undefined : cycleId() } satisfies Live)
}

const aarCost = async ($: EngineInterface) =>
  ((await $.store.get(STATE_KEY)) as number | undefined) ?? AAR_COST_PCT

/**
 * Trips the guard: no new work starts, running calls and agents finish and
 * checkpoint, then the AAR is written. The thresholds tighten with the number
 * of threads that must write an AAR from the same window, and a trip in one
 * session trips every other session in that window.
 */
type Act = { abort?: string | string[] } | undefined
/** Runs what an inner step asked for after the lock is released (an abort waits on hooks that take the lock). */
const act = async ($: EngineInterface, r: Act) => {
  if (!r?.abort) return
  // Deepest agent first, the main loop last (the list is in that order).
  for (const turnId of Array.isArray(r.abort) ? r.abort : [r.abort]) {
    await $.turn.abort({ turnId } as never).catch(() => undefined)
  }
}
const maybeTrigger = async ($: EngineInterface) => act($, await serial(() => maybeTriggerInner($)))
async function maybeTriggerInner($: EngineInterface): Promise<Act> {
  if (G.phase !== 'idle') return
  const epoch = gen
  const [t, g, u] = [await read($, tasks), await read($, egm), await read($, usage)]
  const now = await $.clock.now()
  const held = await holdUntil($)
  if (now < held) {
    // A held guard whose window turned out fresh (reset, other account) no longer needs the hold.
    if (windowFresh(u.fiveHour?.pct) && !(u.fiveHour?.resetsAt && Date.parse(u.fiveHour.resetsAt) <= now)) await clearHold($)
    return
  }
  const f = forecast(t, g, u, S.model, now, turnStart())
  // A reading whose window has already reset is stale: the next response refreshes it.
  const stale = !!u.fiveHour?.resetsAt && Date.parse(u.fiveHour.resetsAt) <= now
  const used = stale ? undefined : u.fiveHour?.pct
  const lt = await liveThreads($)
  const th = thresholds(lt.n, await aarCost($), burnRate(now))
  const own = shouldTripAt(used, f.pctNeeded, th)
  const trip = (await $.store.get(TRIP_KEY)) as Trip | undefined
  // A trip kept from a window this reading shows is gone (reset, or another account) is dropped.
  if (trip && windowFresh(used)) await $.store.delete(TRIP_KEY)
  const shared = !!trip && !windowFresh(used) && Date.parse(trip.resetsAt) > now
  if (!own && !shared) return
  const hasWork = G.running || lt.running > 0 || f.pending > 0 || (g && !g.doneAt)
  if (!hasWork) return
  // An /eta override or a timed-out step may have come while this one awaited.
  if (epoch !== gen || G.phase !== 'idle' || (await $.clock.now()) < (await holdUntil($))) return
  const resetsAt = (stale ? undefined : u.fiveHour?.resetsAt) ?? trip?.resetsAt
  if (own) {
    await $.store.set(TRIP_KEY, { resetsAt: resetsAt ?? new Date(now + 5 * 3600_000).toISOString(), at: now } satisfies Trip)
  }
  G.phase = 'draining'
  newCycle(AG, now)
  G.armed = false
  G.baseline = used !== undefined
  G.used = used ?? 0
  G.est = (used ?? 0) + f.pctNeeded
  G.threads = lt.n
  G.drainAt = now
  G.resetsAt = resetsAt
  G.aar = aarPath(await $.session.cwd(), now, await sidTag($))
  $.ui.toast(
    `5h limit ${used?.toFixed(0) ?? '?'}% (guard trips at ${th.used.toFixed(0)}% for ${lt.n} thread(s)): ` +
      'finishing running work, then writing the AAR',
  )
  await heartbeat($)
  return advanceDrainInner($)
}

/** Draining ends when the main loop is idle and no agent runs (or after DRAIN_MAX_MS). */
const advanceDrain = async ($: EngineInterface) => act($, await serial(() => advanceDrainInner($)))
async function advanceDrainInner($: EngineInterface): Promise<Act> {
  if (G.phase !== 'draining') return
  const epoch = gen
  const now = await $.clock.now()
  const lt = await liveThreads($)
  if (epoch !== gen || G.phase !== 'draining') return // overridden or released while the thread count was read
  const late = now - G.drainAt > DRAIN_MAX_MS
  if (late && !G.bypass?.turnId) {
    // Last resort: turns that never end, at any depth. Their work was denied new tools long ago.
    // Agents go deepest first, so no parent is cut off above a child that still runs; the main loop is last.
    const turns = abortOrder(AG, now)
    for (const r of liveAgents(AG, now)) noteEnd(AG, r.id, now) // not aborted twice
    if (G.running && G.turnId) turns.push(G.turnId)
    if (turns.length > 0) return { abort: turns }
  }
  if (G.running || (lt.running > 0 && !late)) return
  // A bypassed prompt still to run comes first; one that never started stops holding the AAR once the drain is late.
  if (G.bypass && !(late && G.bypass.turnId === undefined)) return
  G.phase = 'writing'
  G.armed = false
  G.writeAt = now
  const resetIn = fmtMin(Math.max(0, (Date.parse(G.resetsAt ?? '') - now) / 60000) || 300)
  // Submitted from a timer: a prompt cannot be queued from inside the hook of the turn it follows.
  const text = aarPrompt(G.aar, G.used, G.est, resetIn, G.threads, G.manual)
  $.clock.after(500, () => {
    if (G.phase !== 'writing') return // released or resumed meanwhile: no AAR request
    void $.prompt.submit({ text }).catch(() => {
      void serial(async () => {
        if (G.phase === 'writing') await failCycle($, 'The AAR request could not be sent')
      })
    })
  })
}

/** The AAR turn is done: learn its cost, then clear or keep the session and arm the resume. */
/** A guard cycle that ended without an AAR: back to idle, prompts handed back, no retry loop. */
async function failCycle($: EngineInterface, msg: string) {
  const now = await $.clock.now()
  G.phase = 'idle'
  G.armed = false
  G.bypass = undefined
  const held = await dropHeld($) // not left behind for an unrelated later AAR
  const back = held ? `\nThese prompts were held and not run, send them again:\n${held}` : ''
  if (G.manual) {
    G.manual = false
    $.ui.toast(`${msg} (expected ${G.aar}); the pause is cancelled${back}`)
    return
  }
  await setHold($, now + AAR_RETRY_MS)
  $.ui.toast(`${msg} (expected ${G.aar}); the limit guard is off for ${fmtMin(AAR_RETRY_MS / 60000)}${back}`)
}

const finishAar = ($: EngineInterface) => serial(() => finishAarInner($))
async function finishAarInner($: EngineInterface) {
  if (G.phase !== 'writing') return
  const g = gen
  const now = await $.clock.now()
  const cwd = await $.session.cwd()
  const wrote = await $.fs.exists(G.aar).catch(() => false)
  if (g !== gen || G.phase !== 'writing') return
  if (!wrote) {
    // Hold the guard off for a while, or the very next reading would trip it again and loop.
    await failCycle($, 'AAR was not written')
    return
  }
  await flushCmds($) // prompts held while the AAR was being written go on top of it now
  const pct = (await read($, usage)).fiveHour?.pct
  if (G.baseline && pct !== undefined && pct > G.used) {
    const per = Math.min(8, Math.max(0.2, (pct - G.used) / G.threads))
    const old = await aarCost($)
    await $.store.set(STATE_KEY, old + 0.5 * (per - old))
  }
  if (g !== gen || G.phase !== 'writing') return // released or overridden while the AAR was being read
  const plan = planResume(now, G.resetsAt)
  const manual = G.manual
  const pending: Pending = {
    aar: G.aar,
    cwd,
    resumeAt: manual ? MANUAL_RESUME_AT : plan.resumeAt,
    cleared: manual ? false : plan.clear,
    oldSession: await $.session.id(),
    manual,
    claimedBy: await $.session.id(),
  }
  // Saved first: a pause with a claim but no record would step down at the resume, and no session could adopt it.
  await $.store.set(storeKey(pending.aar), pending)
  if (g !== gen || G.phase !== 'writing') {
    await $.store.delete(storeKey(pending.aar)).catch(() => undefined) // released while it was being saved
    return
  }
  G.pending = pending
  G.phase = 'waiting'
  await heartbeat($)
  if (manual) {
    $.ui.toast('AAR saved. Paused: run /eta resume when you are back')
    return
  }
  $.ui.toast(
    plan.clear
      ? `AAR saved. Reset in ${fmtMin(plan.waitMin)} (cache will be cold): clearing, resuming from the AAR`
      : `AAR saved. Reset in ${fmtMin(plan.waitMin)}: resuming in this session`,
  )
  if (plan.clear) {
    $.clock.after(2000, () => {
      void $.command.run({ command: 'clear' }).catch(() => {
        // Could not clear: resume in this session instead.
        if (G.pending) G.pending = { ...G.pending, cleared: false }
      })
    })
  }
}

/** Fires the resume when the reset has passed; purges the superseded session. */
const checkResume = ($: EngineInterface) => serial(() => checkResumeInner($))
async function checkResumeInner($: EngineInterface) {
  if (G.phase !== 'waiting' || !G.pending) return
  const now = await $.clock.now()
  const p = G.pending
  if (now < p.resumeAt) return
  const g = gen
  const sid = await $.session.id()
  // Another session adopted this pause after a sleep or a restart: the last claim stands, this one steps down.
  // A store error is not a deleted record: try again at the next tick instead of giving the pause up.
  const READ_FAILED = Symbol('read failed')
  const read1 = await $.store.get(storeKey(p.aar)).then(
    x => x,
    () => READ_FAILED,
  )
  if (read1 === READ_FAILED) return
  const saved = read1 as Pending | undefined
  // (compared with the claim this process holds, not the session id: a /clear changes the id and not the claim)
  // A record that is gone (the adopter resumed and deleted it) is a foreign claim too: no second resume.
  if (p.claimedBy && (!saved || (saved.claimedBy && saved.claimedBy !== p.claimedBy))) {
    G.phase = 'idle'
    G.pending = undefined
    G.manual = false
    $.ui.toast('Another session took over this pause; it will resume from the AAR')
    return
  }
  const written = await flushCmds($)
  const cmds = await loadCmds($)
  if (g !== gen || G.phase !== 'waiting' || G.pending !== p) return // released, overridden or resumed meanwhile
  const held = cmds.filter(c => c.kind === 'held')
  // A failed write must not lose the prompts: they go into the resume prompt itself.
  const inline = !written && held.length > 0 ? commandsBlock(cmds) : ''
  G.phase = 'idle'
  G.pending = undefined
  G.manual = false
  G.bypass = undefined
  await $.store.delete(storeKey(p.aar))
  await $.store.delete(cmdsKey(p.aar))
  void $.prompt
    .submit({ text: resumePrompt(p.aar, p.cleared, written && held.length > 0, !!p.manual, inline) })
    .catch(() => $.ui.toast(`The resume prompt could not be sent; tell the session to read the AAR at ${p.aar}`))
  // Never move the transcript of the session that is running now (e.g. one resumed with --resume).
  // ...nor one whose session is still alive (resumed with --resume, or woke from sleep).
  const alive = (await liveIds($)).some(l => l.id === p.oldSession && now - l.t <= LIVE_MS)
  if (p.cleared && p.oldSession && p.oldSession !== sid && !alive) {
    // Old sessions are moved to ~/archive/_review/<date>/ (manifest), never deleted outright.
    void $.process
      .run(['sh', '-c', purgeScript, 'sh', p.oldSession, p.aar], { timeoutMs: 20000 })
      .catch(() => undefined)
  }
}

/** Turns the guard off now: drops the pause, the saved resume and the shared trip. */
async function release($: EngineInterface, why: string, showHeld = true) {
  gen++
  const cycle = cycleId()
  const held = await dropHeld($)
  G.bypass = undefined
  G.phase = 'idle'
  G.armed = false
  G.pending = undefined
  G.bypass = undefined
  G.manual = false
  if (cycle) await $.store.delete(storeKey(cycle))
  await $.store.delete(TRIP_KEY)
  $.ui.toast(
    `Limit guard released: ${why}` +
      (held && showHeld ? `. These held prompts were not run; send them again:\n${held}` : ''),
  )
}

/** The held prompts as text, to hand back to the user when the guard is released. */
const heldList = (cmds: readonly Cmd[]) =>
  cmds
    .filter(c => c.kind === 'held')
    .map((c, i) => `${i + 1}. ${c.text.trim().replace(/\r?\n/g, '\n   ')}`)
    .join('\n')

/** The newest AAR on disk for this folder: what a resume uses when the saved pause is gone. */
async function latestAar($: EngineInterface, cwd: string): Promise<string | undefined> {
  const root = `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/.claude/aar`
  const dirs = await $.fs.list(root).catch(() => [])
  for (const d of dirs.filter(x => x.kind === 'dir').map(x => x.name).sort().reverse()) {
    const path = `${root}/${d}/AAR.md`
    if (await $.fs.exists(path).catch(() => false)) return path
  }
  return undefined
}

/**
 * A fresh reading from a new window (a reset, or another account) ends a stale
 * guard: a pause with an AAR resumes from it now; a drain or AAR request stops.
 */
const maybeRelease = ($: EngineInterface, usedPct: number, resetsAt: string | undefined) =>
  serial(() => maybeReleaseInner($, usedPct, resetsAt))
async function maybeReleaseInner($: EngineInterface, usedPct: number, resetsAt: string | undefined) {
  // A pause the person asked for ends only on /eta resume, whatever the limit reads.
  if (G.phase === 'idle' || G.manual || !windowFresh(usedPct)) return
  const now = await $.clock.now()
  if (resetsAt && Date.parse(resetsAt) <= now) return // stale reading: wait for the next one
  if (G.phase === 'waiting' && G.pending) {
    G.pending = { ...G.pending, resumeAt: now }
    await $.store.delete(TRIP_KEY)
    $.ui.toast(`5h window at ${usedPct.toFixed(0)}%: resuming from the AAR now`)
    await checkResumeInner($)
    return
  }
  await release($, `5h window at ${usedPct.toFixed(0)}%`)
}

/** Live sessions' heartbeats: id, last beat and the guard cycle each is in. */
async function liveIds($: EngineInterface) {
  const out: { id: string; t: number; cycle?: string }[] = []
  for (const k of await $.store.keys().catch(() => [] as string[])) {
    if (!k.startsWith('live:')) continue
    const v = (await $.store.get(k).catch(() => undefined)) as Live | undefined
    if (v) out.push({ id: k.slice(5), t: v.t, cycle: v.cycle })
  }
  return out
}

/** The newest saved pause of this folder that no other live session is in; `blocked` when only a live one exists. */
async function findPause($: EngineInterface, cwd: string): Promise<{ rec?: Pending; blocked?: boolean }> {
  const recs: Pending[] = []
  const [now, sid, live] = [await $.clock.now(), await $.session.id(), await liveIds($)]
  let legacyBlocked = false
  for (const k of await $.store.keys().catch(() => [] as string[])) {
    if (!k.startsWith(RESUME_PREFIX)) continue
    const v = (await $.store.get(k).catch(() => undefined)) as Pending | undefined
    if (!v?.aar || v.cwd !== cwd) continue
    // A pause saved by 0.1.5 under the folder key moves to its cycle key, so it is deleted when used.
    if (k !== storeKey(v.aar)) {
      // A 0.1.5 session writes no cycle in its heartbeat: while its session beats, the pause is its own.
      if (v.oldSession && v.oldSession !== sid && live.some(l => l.id === v.oldSession && now - l.t <= LIVE_MS)) {
        legacyBlocked = true
        continue
      }
      await $.store.set(storeKey(v.aar), v)
      await $.store.delete(k)
    }
    recs.push(v)
  }
  if (recs.length === 0) return legacyBlocked ? { blocked: true } : {}
  const free = recs.filter(r => mayAdopt(r, sid, live, now)).sort((a, b) => b.aar.localeCompare(a.aar))
  return free[0] ? { rec: free[0] } : { blocked: true }
}

/** Held prompts left by a cycle that ended without a saved pause (a crash): handed back, not kept for a stranger. */
async function reapOrphans($: EngineInterface) {
  const root = `${(await $.session.cwd()).replace(/\\/g, '/').replace(/\/+$/, '')}/.claude/aar/`
  const [now, sid, live] = [await $.clock.now(), await $.session.id(), await liveIds($)]
  const prefix = cmdsKey('')
  for (const k of await $.store.keys().catch(() => [] as string[])) {
    if (!k.startsWith(prefix)) continue
    const aar = k.slice(prefix.length)
    if (!aar.startsWith(root) || aar === cycleId()) continue
    if (await $.store.get(storeKey(aar)).catch(() => undefined)) continue // a pause owns them
    if (live.some(l => l.id !== sid && l.cycle === aar && now - l.t <= LIVE_MS)) continue
    const held = heldList(((await $.store.get(k).catch(() => undefined)) as Cmd[] | undefined) ?? [])
    await $.store.delete(k).catch(() => undefined)
    if (held) $.ui.toast(`These prompts were held when a guard cycle ended without a saved pause; send them again:\n${held}`)
  }
}

/**
 * Picks a saved pause back up (after a restart), once, when the session starts.
 * A pause another live session is in stays with that session.
 */
const adoptSaved = ($: EngineInterface) => serial(() => adoptSavedInner($))
async function adoptSavedInner($: EngineInterface): Promise<'adopted' | 'blocked' | 'none'> {
  if (G.phase !== 'idle') return 'none'
  const { rec, blocked } = await findPause($, await $.session.cwd())
  if (!rec) return blocked ? 'blocked' : 'none'
  // A pause the person made survives a restart (and an /eta override's hold); a limit pause waits out a hold.
  if (!rec.manual && (await $.clock.now()) < (await holdUntil($))) return 'none'
  const sid = await $.session.id()
  const claimed: Pending = { ...rec, cleared: rec.oldSession === sid ? rec.cleared : true, claimedBy: sid }
  G.pending = claimed
  G.manual = !!rec.manual
  G.phase = 'waiting'
  await heartbeat($)
  // Two sessions starting together can both pass the check: the claim written last stands (the other
  // sees it when it reads the record back, or at its next resume check, and steps down).
  await $.store.set(storeKey(rec.aar), claimed)
  const back = (await $.store.get(storeKey(rec.aar)).catch(() => undefined)) as Pending | undefined
  // The claim read back decides alone: a second, id-based rule could make both sessions step down.
  if (back?.claimedBy && back.claimedBy !== sid) {
    G.pending = undefined
    G.manual = false
    G.phase = 'idle'
    await heartbeat($)
    return 'blocked'
  }
  return 'adopted'
}

/** A writing phase whose AAR turn never ends must not hold the session forever. */
const advanceWrite = async ($: EngineInterface) => act($, await serial(() => advanceWriteInner($)))
async function advanceWriteInner($: EngineInterface): Promise<Act> {
  if (G.phase !== 'writing' || (await $.clock.now()) - G.writeAt <= WRITE_MAX_MS) return
  const turnId = G.running ? G.turnId : undefined
  await finishAarInner($) // written: resume as usual; not written: back to idle, prompts handed back
  return turnId ? { abort: turnId } : undefined
}

/** The /eta command, run under the guard lock: it reads and changes the phase across awaits. */
async function etaCommand($: EngineInterface, e: { args: string }) {
  const arg = (e.args ?? '').trim().toLowerCase()
  if (arg === 'guard on' || arg === 'override off') {
    await clearHold($)
    return { text: 'runway: the limit guard is on again' }
  }
  if (/^bypass\b/.test(arg)) {
    const prompt = e.args.trim().replace(/^bypass\s*/i, '').trim()
    if (!prompt) {
      return { text: 'runway: the syntax is /eta bypass <your prompt>: it runs that prompt once with the limit guard lifted' }
    }
    const now = await $.clock.now()
    if (G.phase !== 'idle') {
      G.bypass = { text: prompt, at: now }
    }
    // Submitted from a timer (a prompt cannot be queued from inside a command), as the user's own words.
    $.clock.after(300, () => {
      void $.prompt.submit({ text: prompt, asUser: true }).catch(() => {
        G.bypass = undefined
        $.ui.toast(`Could not submit the bypassed prompt; it was not run: ${prompt.slice(0, 200)}`)
      })
    })
    return {
      text:
        G.phase === 'idle'
          ? 'runway: the limit guard is not active; running your prompt normally'
          : 'runway: running your prompt with the limit guard lifted for this turn only',
    }
  }
  if (arg === 'pause') {
    // Manual pause (leaving, a restart, a network outage): the same drain and AAR as the limit guard,
    // then it stays paused until /eta resume, whatever the 5h window does. Survives a restart.
    const cwd = await $.session.cwd()
    if (G.phase === 'waiting' && G.pending) {
      if (G.pending.manual) return { text: 'runway: already paused; run /eta resume when you are back' }
      G.manual = true
      G.pending = { ...G.pending, manual: true, resumeAt: MANUAL_RESUME_AT }
      await $.store.set(storeKey(G.pending.aar), G.pending)
      return { text: 'runway: the pause now stays until you run /eta resume (it will not resume at the limit reset)' }
    }
    if (G.phase !== 'idle') {
      G.manual = true
      return { text: 'runway: the AAR is already being saved; the session then stays paused until you run /eta resume' }
    }
    const now = await $.clock.now()
    G.manual = true
    G.phase = 'draining'
    newCycle(AG, now)
    G.armed = false
    const pct0 = (await read($, usage)).fiveHour?.pct
    G.baseline = pct0 !== undefined
    G.used = pct0 ?? 0
    G.est = G.used
    G.threads = (await liveThreads($)).n
    G.drainAt = now
    G.resetsAt = undefined
    G.aar = aarPath(cwd, now, await sidTag($))
    await heartbeat($) // the held prompts of this cycle are not orphans to a session starting now
    $.ui.toast('Paused by you: finishing running work, then writing the AAR (/eta resume continues)')
    await advanceDrainInner($)
    return {
      text:
        'runway is pausing: running work finishes, then the AAR is written and the session holds. ' +
        'Run /eta resume when you are back (it also survives a restart).',
    }
  }
  if (arg === 'resume') {
    // Manual resume: the person reset the limits or switched account, so continue from the AAR now,
    // exactly as the timer would have after the reset.
    const cwd = await $.session.cwd()
    const was = G.phase
    // Only an idle session looks at other pauses: mid-drain or mid-write there is nothing of its own to resume.
    const found = G.pending ? { rec: G.pending } : G.phase === 'idle' ? await findPause($, cwd) : {}
    if (!found.rec && found.blocked) {
      return { text: 'runway: the saved pause in this folder belongs to another running session; run /eta resume there' }
    }
    const own = found.rec
    const mine = !own && G.aar && (await $.fs.exists(G.aar).catch(() => false)) ? G.aar : undefined
    // Mid-drain or mid-write the new AAR does not exist yet: an older one on disk is another task's.
    const inFlight = !own && (was === 'draining' || was === 'writing')
    const aar = own?.aar ?? mine ?? (inFlight ? undefined : await latestAar($, cwd))
    const now = await $.clock.now()
    const wasManual = !!own?.manual || (G.manual && !own)
    G.bypass = undefined
    if (!wasManual) {
      // The old window's reading and trip no longer apply; the next response brings the new one.
      G.readings = []
      S.lastPct = undefined
      await clearHold($).catch(() => undefined)
      await $.store.delete(TRIP_KEY).catch(() => undefined)
      await update($, usage, u => ({ ...u, fiveHour: undefined }))
    }
    if (!aar) {
      G.phase = 'idle'
      G.armed = false
      G.manual = false
      G.pending = undefined
      const back = await dropHeld($)
      const tail = back ? `\nThese prompts were held and not run, send them again:\n${back}` : ''
      return {
        text:
          (was === 'idle'
            ? 'runway: no AAR found for this folder, nothing to resume from'
            : `runway: the limit guard is released (was ${was}); no AAR was written yet, so there is nothing to resume from`) +
          tail,
      }
    }
    G.pending = {
      aar,
      cwd,
      resumeAt: now,
      cleared: own?.cleared ?? false,
      oldSession: own?.oldSession ?? '',
      manual: own?.manual,
      claimedBy: own?.claimedBy,
    }
    G.phase = 'waiting'
    // Submitted from a timer (a prompt cannot be queued from inside a command); checkResume sends it.
    $.clock.after(300, () => void checkResume($).catch(() => undefined))
    return { text: `runway: resuming from the AAR at ${aar} now (guard reset, the 5h window is read afresh)` }
  }
  if (arg === 'override') {
    const was = G.phase
    const heldNow = heldList(await loadCmds($))
    const resetsAt = Date.parse((await read($, usage)).fiveHour?.resetsAt ?? '')
    const now = await $.clock.now()
    // The hold lives in the store, so every session (and a session a /clear starts) honours it.
    // Phase first, then the store: a failing store call must not leave the guard on.
    G.phase = 'idle'
    G.armed = false
    await setHold($, Number.isFinite(resetsAt) && resetsAt > now ? resetsAt : now + 5 * 3600_000).catch(() => undefined)
    await release($, 'overridden with /eta override', false).catch(() => undefined)
    const base =
      was === 'idle'
        ? 'runway: the limit guard is held off until the 5h window resets (/eta guard on turns it back on)'
        : `runway: limit guard released (was ${was}); tools are allowed again until the 5h window resets`
    return {
      text: heldNow ? `${base}\nThese prompts were held and not run, send them again if you want them:\n${heldNow}` : base,
    }
  }
  void $.ui.open({ id: PANE, title: 'Usage & ETA' }) // not awaited: it must not hold the guard lock
  return { text: await summary($) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ensure($)
    S.mark = { t: await $.clock.now(), tok: 0 }
    S.todos = []
    AG.clear() // a restart keeps no agent of the last process
    await $.command.register({
      name: 'eta',
      description: 'Show usage limits, tasks and the ETA estimator (/eta pause saves an AAR and holds until /eta resume; /eta override releases the limit guard)',
      argumentHint: 'pause | resume | bypass <prompt> | override | guard on',
    })
    void $.ui.open({ id: PANE, title: 'Usage & ETA' })
    $.clock.every(30000, () => {
      $.ui.invalidate('ui.render')
      void (async () => {
        await refreshModel($)
        // A bypassed prompt whose turn never started (submit lost) must not hold the guard forever.
        if (G.bypass && G.bypass.turnId === undefined && (await $.clock.now()) - G.bypass.at > 120_000 && !G.running && G.phase !== 'writing') {
          $.ui.toast(`The bypassed prompt had not started after 2 minutes (it may still be queued behind the AAR); if it never runs, send it again: ${G.bypass.text.slice(0, 200)}`)
          G.bypass = undefined
        }
        await heartbeat($)
        await checkResume($)
        await advanceDrain($)
        await advanceWrite($)
        await maybeTrigger($)
      })().catch(() => undefined)
    })
    // A restart while waiting for the reset: pick the pending resume back up.
    after = (ms, cb) => void $.clock.after(ms, cb)
    await serial(() => reapOrphans($)).catch(() => undefined)
    if ((await adoptSaved($)) === 'blocked') {
      // The owner's last heartbeat may be from a session that just closed: look once more when it has gone stale.
      $.clock.after(LIVE_MS + 5000, () => {
        if (!G.sawTurn) void adoptSaved($).catch(() => undefined)
      })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const agentId = (e as { agentId?: string }).agentId
    if (agentId) noteSeen(AG, agentId, await $.clock.now(), e.turnId)
    if (!agentId) {
      G.sawTurn = true
      G.turnId = e.turnId
      G.running = true
      S.turn = {
        id: e.turnId,
        t: await $.clock.now(),
        tok: (await read($, usage)).tokens,
        // The guard's own AAR and resume turns are not typical work: leave them out of the pace.
        skip: (e.text ?? '').includes(MARKER) || (e.text ?? '').includes(RESUME_MARKER),
      }
      if (G.phase === 'writing' && e.text.includes(MARKER)) G.armed = true
      // The guard's own AAR and resume prompts can contain the bypassed words: never match those.
      if (
        G.bypass &&
        G.bypass.turnId === undefined &&
        !e.text.includes(MARKER) &&
        !e.text.includes(RESUME_MARKER) &&
        e.text.includes(G.bypass.text)
      ) {
        G.bypass.turnId = e.turnId
        // Recorded now that it runs (not when it was asked for: a lost submit leaves no false record).
        await addCmd($, G.bypass.text, 'bypass')
      }
    }
    return next(e)
  })

  on('command.run', { command: 'eta' }, ($, e) => serial(() => etaCommand($, e)))

  // /eta pause, resume, bypass <prompt>, override, guard on: offered in the typeahead as the word after /eta is typed.
  on('prompt.autocomplete', async ($, e, next) => {
    const r = await next(e)
    const rows = etaCompletions(e.text, e.start, e.token)
    return rows.length > 0 ? { suggestions: [...r.suggestions, ...rows] } : r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, ETA_RULE] }
  })

  on('prompt.submit', async ($, e, next) => {
    // While the guard is active the user's prompts are not sent to the model (no tokens spent on a
    // turn whose tools are all refused): each is saved verbatim and written onto the top of the AAR.
    if (G.phase !== 'idle' && isHeldPrompt(e, G.bypass?.text) && (await holdPrompt($, e.text))) {
      return {
        drop:
          'Usage guard active: this message was saved and will be placed at the top of the AAR, to be ' +
          'handled first after the resume. Use /eta resume to continue now, /eta bypass <message> to run it now, or /eta override to lift the guard.',
      }
    }
    S.mark = { t: await $.clock.now(), tok: (await read($, usage)).tokens }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const callerId = (e as { agentId?: string }).agentId
    if (callerId) noteSeen(AG, callerId, await $.clock.now())
    if (G.phase !== 'idle' && G.bypass?.turnId === undefined) {
      const dir = aarDirOf(G.aar || G.pending?.aar || '')
      const agentId = callerId
      if (!toolAllowed(G.phase, tool, e as unknown as { file_path?: string; command?: string }, dir)) {
        if (agentId) {
          // An agent at any depth that keeps calling tools after the checkpoint request is stopped.
          const turnId = AG.get(agentId)?.turnId
          if (noteDenied(AG, agentId, await $.clock.now()) && turnId) {
            // Not awaited: the abort waits on hooks, and this is one of them.
            $.clock.after(0, () => void act($, { abort: turnId }))
          }
        }
        return { deny: denyText(G.phase, !!agentId, dir, agentId ?? '', G.manual) }
      }
    }
    if (tool === 'Agent') {
      const input = e as unknown as { subagent_type?: string; description?: string }
      const id = e.tool_use_id ?? ''
      const isNew =
        id !== '' &&
        (await startStep($, id, input.subagent_type ?? 'general-purpose', input.description ?? ''))
      const ran = await timeAgent($, id, input.subagent_type ?? 'general-purpose', () => next(e))
      if (isNew) await endStep($, id)
      return ran
    }
    if (!TRACKED.has(tool)) return next(e)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      if (S.todos.length === 0) S.todos = await replay($)
      S.todos = applyTool(S.todos, tool, e as unknown as Record<string, unknown>, ran.text)
      await ingest($, S.todos)
      await refreshStatus($)
    }
    return ran
  })

  on('skill.prompt', async ($, e, next) => {
    const name = skillName(e.skill)
    if (name.startsWith('egm') || e.pluginName === 'egm') {
      const run: EgmRun = { skill: name, startedAt: await $.clock.now(), steps: [] }
      await update($, egm, () => run)
      void $.ui.open({ id: PANE, title: 'Usage & ETA' })
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    // While the guard is active no agent starts, whoever asks and at whatever depth (a plugin's spawn,
    // a workflow, an agent's own child): the Agent tool is refused at tool.call, this covers the rest.
    if (G.phase !== 'idle' && G.bypass?.turnId === undefined) {
      return {
        deny: 'Usage guard: the 5h limit is nearly spent or the session is paused. No agent starts now; write your checkpoint instead.',
      } as never
    }
    const isNew =
      e.tool_use_id !== '' && (await startStep($, e.tool_use_id, e.subagentType, e.description))
    const ran = await timeAgent($, e.tool_use_id, e.subagentType, () => next(e))
    if (isNew) await endStep($, e.tool_use_id)
    const spawned = (ran as { agentId?: string }).agentId
    if (spawned) {
      noteSpawn(AG, spawned, (e as { parentAgentId?: string }).parentAgentId, e.subagentType, await $.clock.now())
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    const doneAgent = (e as { agentId?: string }).agentId
    if (doneAgent) noteEnd(AG, doneAgent, now)
    if (r.usage) {
      const eff = effective(r.usage)
      S.tokSincePct += eff
      await update($, usage, u => ({ ...u, tokens: u.tokens + eff }))
    }
    const isMain = !(e as { agentId?: string }).agentId
    if (isMain && S.turn && S.turn.id === e.turnId) {
      const t = S.turn
      S.turn = undefined
      const min = (now - t.t) / 60000
      const tokens = (await read($, usage)).tokens - t.tok
      // A turn left open for hours is a stall, not work.
      if (!t.skip && min <= 120) await learn($, m => learnTurn(m, { min, tokens })).catch(() => undefined)
    }
    const run = await read($, egm)
    if (isMain && run && !run.doneAt && run.steps.every(s => s.doneAt)) {
      const finished = { ...run, doneAt: now }
      await update($, egm, () => finished)
      await learn($, m => learnEgm(m, finished, now))
    }
    if (isMain) await reconcile($)
    await refreshStatus($)
    if (isMain) {
      G.running = false
      if (G.bypass?.turnId !== undefined && G.bypass.turnId === e.turnId) G.bypass = undefined
      // `armed` can be missed (a rewritten prompt); a written AAR file settles it too.
      if (G.phase === 'writing' && (G.armed || (await $.fs.exists(G.aar).catch(() => false)))) await finishAar($)
      else if (G.phase === 'draining') await advanceDrain($)
      else await maybeTrigger($)
      await checkResume($)
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    const pick = (k: string) => e.rateLimits.find(l => l.kind.includes(k))
    const five = pick('five')
    const week = pick('seven')
    await ensure($)
    if (five) {
      if (S.lastPct !== undefined && five.percentUsed > S.lastPct) S.pctSince += five.percentUsed - S.lastPct
      if (S.lastPct === undefined || five.percentUsed < S.lastPct) {
        S.tokSincePct = 0
        S.pctSince = 0
      }
      // Too few tokens for the gain is noise (other sessions spend the limit too): keep
      // accumulating both until there is a real sample, instead of dropping the tokens.
      if (S.pctSince > 0 && S.tokSincePct >= 20000) {
        const [pct, tok] = [S.pctSince, S.tokSincePct]
        S.pctSince = 0
        S.tokSincePct = 0
        await learn($, m => learnRate(m, pct, tok))
      }
      S.lastPct = five.percentUsed
      G.readings = [...G.readings.slice(-20), { t: await $.clock.now(), pct: five.percentUsed }]
    }
    await update($, usage, u => ({
      ...u,
      usd: e.cost?.usd ?? u.usd,
      fiveHour: five ? { pct: five.percentUsed, resetsAt: five.resetsAt } : u.fiveHour,
      week: week ? { pct: week.percentUsed, resetsAt: week.resetsAt } : u.week,
    }))
    await refreshStatus($)
    const ran = await next(e)
    if (five) await maybeRelease($, five.percentUsed, five.resetsAt)
    await maybeTrigger($)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await ensure($)
    const [t, g, u] = [await read($, tasks), await read($, egm), await read($, usage)]
    const now = await $.clock.now()
    const f = forecast(t, g, u, S.model, now, turnStart())
    const reset = (l?: { resetsAt?: string }) =>
      l?.resetsAt ? ` · resets in ${fmtMin((Date.parse(l.resetsAt) - now) / 60000)}` : ''
    const doneCount = t.filter(x => x.status === 'completed').length
    const icon = (s: Task['status']) => (s === 'completed' ? '✔' : s === 'in_progress' ? '▶' : '○')
    const left = expectedAgents(g, S.model)
    const hasWork = f.pending > 0 || (g && !g.doneAt)
    const five = barParts(u.fiveHour?.pct ?? 0, hasWork ? f.pctNeeded : 0)
    const wk = barParts(u.week?.pct ?? 0, 0)

    return (
      <Box flexDirection="column">
        <Text bold>Limits</Text>
        <Box flexDirection="row">
          <Text>5h   </Text>
          <Text color="red">{'█'.repeat(five.used)}</Text>
          <Text color="white">{'█'.repeat(five.est)}</Text>
          <Text dimColor>{'░'.repeat(five.free)}</Text>
          <Text>
            {' '}
            {u.fiveHour ? `${u.fiveHour.pct.toFixed(0)}%` : '--'}
            {f.pending > 0 || (g && !g.doneAt) ? ` +${f.pctNeeded.toFixed(0)}% est` : ''}
            {reset(u.fiveHour)}
          </Text>
        </Box>
        <Box flexDirection="row">
          <Text>Week </Text>
          <Text color="red">{'█'.repeat(wk.used)}</Text>
          <Text dimColor>{'░'.repeat(wk.free)}</Text>
          <Text>
            {' '}
            {u.week ? `${u.week.pct.toFixed(0)}%` : '--'}
            {reset(u.week)}
          </Text>
        </Box>
        {G.phase !== 'idle' && (
          <Text color="yellow">
            Limit guard: {G.phase === 'draining' ? 'finishing running work' : G.phase === 'writing' ? 'writing the AAR' : G.manual ? 'paused by you (/eta resume to continue)' : `paused, resumes ${G.pending?.cleared ? 'after /clear ' : ''}at ${new Date(G.pending?.resumeAt ?? now).toLocaleTimeString()} (/eta resume to go now)`}
          </Text>
        )}
        <Text dimColor>red used · white estimated for the tasks left · dim unused</Text>
        <Text dimColor>
          Session: {fmtTok(u.tokens)} effective tokens · ${u.usd.toFixed(2)}
        </Text>

        <Text bold> </Text>
        <Text bold>
          Tasks {doneCount}/{t.length}
        </Text>
        {t.length === 0 && <Text dimColor>No todo list yet.</Text>}
        {t.map(x => {
          const est = estTaskMin(x, S.model)
          const spent =
            x.startedAt !== undefined ? ((x.doneAt ?? now) - x.startedAt) / 60000 : undefined
          return (
            <Text dimColor={x.status === 'completed'}>
              {icon(x.status)} {x.text}
              {x.status === 'completed'
                ? ` · ${fmtMin(spent ?? 0)}${x.eta ? ` (llm ${fmtMin(x.eta)})` : ''}`
                : ` · est ${fmtMin(est)}${x.eta ? ` (llm ${fmtMin(x.eta)})` : ''}`}
              {x.status === 'in_progress' && spent !== undefined ? ` · ${fmtMin(spent)} in` : ''}
            </Text>
          )
        })}

        {g && (
          <Box flexDirection="column">
            <Text bold> </Text>
            <Text bold>
              EGM · {g.skill} {g.doneAt ? `· done in ${fmtMin((g.doneAt - g.startedAt) / 60000)}` : ''}
            </Text>
            {g.steps.map(s => (
              <Text dimColor={!!s.doneAt}>
                {s.doneAt ? '✔' : '▶'} {s.type.replace('egm:', '')}
                {s.label ? ` · ${s.label}` : ''} · {fmtMin(((s.doneAt ?? now) - s.startedAt) / 60000)}
              </Text>
            ))}
            {left.map(type => (
              <Text dimColor>
                ○ {type.replace('egm:', '')} · est {fmtMin(agentMinOf(S.model, g.skill, type))}
              </Text>
            ))}
          </Box>
        )}

        <Text bold> </Text>
        <Text bold>Forecast</Text>
        {f.pending === 0 && !(g && !g.doneAt) ? (
          <Text dimColor>Nothing left to estimate.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              ETA {fmtMin(f.remainingMin)} (range {fmtMin(f.lowMin)}–{fmtMin(f.highMin)})
            </Text>
            <Text>
              Tokens ~{fmtTok(f.tokens)} · ~{f.pctNeeded.toFixed(0)}% of the 5h limit
            </Text>
            <Text color={f.fits ? 'green' : 'red'}>
              {f.fits ? '✔ Fits' : '✘ Will not fit'}: {f.reason}
            </Text>
          </Box>
        )}

        <Text bold> </Text>
        <Text dimColor>
          Model: {S.model.n} ETA samples · llm ×{correction(S.model).toFixed(2)} · error ±
          {(S.model.mape * 100).toFixed(0)}% · {fmtTok(S.model.tokPerMin)} tok/min · {S.model.pctPerMtok.toFixed(1)}%/Mtok
          {f.isLearning ? ' · still learning' : ''}
        </Text>
        <Text dimColor>
          Learned from: {S.model.nAll} tasks · {S.model.nTurn} turns · {S.model.nAgent} agent runs · {S.model.nRate} rate readings
        </Text>
      </Box>
    )
  })
}
