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
  learnEgm,
  learnRate,
  learnTask,
  syncTodos,
  applyTool,
  TRACKED,
} from './estimator'
import type { Todo } from './estimator'
import {
  AAR_COST_PCT,
  DRAIN_MAX_MS,
  LIVE_MS,
  MARKER,
  STATE_KEY,
  TRIP_KEY,
  aarDirOf,
  aarPath,
  aarPrompt,
  countThreads,
  denyText,
  liveKey,
  planResume,
  purgeScript,
  resumePrompt,
  shouldTripAt,
  storeKey,
  thresholds,
  toolAllowed,
  windowFresh,
} from './guard'
import type { Live, Pending, Phase, Trip } from './guard'
import type { Model } from './estimator'

const PANE = 'usage-eta'
const tasks = atom({ plugin: 'usage-eta', key: 'tasks' } as const, [], {
  shape: 'tasks-1',
})
const egm = atom({ plugin: 'usage-eta', key: 'egm' } as const, null, {
  shape: 'egm-2',
})
const usage = atom({ plugin: 'usage-eta', key: 'usage' } as const, { tokens: 0, usd: 0 }, {
  shape: 'usage-1',
})

const ETA_RULE = {
  id: 'usage-eta:eta',
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
  used: 0,
  est: 0,
  threads: 1,
  drainAt: 0,
  resetsAt: undefined as string | undefined,
  pending: undefined as Pending | undefined,
  /** Set by /eta override: the guard stays off until this time (the window's reset). */
  holdUntil: 0,
  /** Recent five-hour readings, for the burn rate. */
  readings: [] as { t: number; pct: number }[],
}

const S = {
  model: blank() as Model,
  loaded: false,
  mark: { t: 0, tok: 0 },
  tokSincePct: 0,
  lastPct: undefined as number | undefined,
  todos: [] as Todo[],
}

async function save($: EngineInterface) {
  await $.store.set('model', S.model)
}

async function ensure($: EngineInterface) {
  if (S.loaded) return
  S.loaded = true
  const saved = (await $.store.get('model')) as Model | undefined
  if (saved && typeof saved.n === 'number') S.model = { ...blank(), ...saved }
}

async function summary($: EngineInterface) {
  const [t, g, u] = [await read($, tasks), await read($, egm), await read($, usage)]
  const now = await $.clock.now()
  const f = forecast(t, g, u, S.model, now)
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
  for (const t of done) {
    S.model = learnTask(S.model, {
      eta: t.eta,
      actualMin: ((t.doneAt ?? now) - (t.startedAt ?? now)) / 60000,
      tokens: u.tokens - (t.tokStart ?? u.tokens),
    })
  }
  if (done.length > 0) await save($)
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
  const agents = await $.agent.list().catch(() => [])
  const running = agents.filter(a => a.status === 'running').length
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
  await $.store.set(liveKey(sid), { t: now, threads: lt.own, cwd } satisfies Live)
}

const aarCost = async ($: EngineInterface) =>
  ((await $.store.get(STATE_KEY)) as number | undefined) ?? AAR_COST_PCT

/**
 * Trips the guard: no new work starts, running calls and agents finish and
 * checkpoint, then the AAR is written. The thresholds tighten with the number
 * of threads that must write an AAR from the same window, and a trip in one
 * session trips every other session in that window.
 */
async function maybeTrigger($: EngineInterface) {
  if (G.phase !== 'idle') return
  const [t, g, u] = [await read($, tasks), await read($, egm), await read($, usage)]
  const now = await $.clock.now()
  if (now < G.holdUntil) return
  const f = forecast(t, g, u, S.model, now)
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
  const resetsAt = (stale ? undefined : u.fiveHour?.resetsAt) ?? trip?.resetsAt
  if (own) {
    await $.store.set(TRIP_KEY, { resetsAt: resetsAt ?? new Date(now + 5 * 3600_000).toISOString(), at: now } satisfies Trip)
  }
  G.phase = 'draining'
  G.armed = false
  G.used = used ?? 0
  G.est = (used ?? 0) + f.pctNeeded
  G.threads = lt.n
  G.drainAt = now
  G.resetsAt = resetsAt
  G.aar = aarPath(await $.session.cwd(), now)
  $.ui.toast(
    `5h limit ${used?.toFixed(0) ?? '?'}% (guard trips at ${th.used.toFixed(0)}% for ${lt.n} thread(s)): ` +
      'finishing running work, then writing the AAR',
  )
  await advanceDrain($)
}

/** Draining ends when the main loop is idle and no agent runs (or after DRAIN_MAX_MS). */
async function advanceDrain($: EngineInterface) {
  if (G.phase !== 'draining') return
  const now = await $.clock.now()
  const lt = await liveThreads($)
  const late = now - G.drainAt > DRAIN_MAX_MS
  if (G.running && late && G.turnId) {
    // Last resort: a turn that never ends. Its work was denied new tools long ago.
    await $.turn.abort({ turnId: G.turnId } as never).catch(() => undefined)
    return
  }
  if (G.running || (lt.running > 0 && !late)) return
  G.phase = 'writing'
  G.armed = false
  const resetIn = fmtMin(Math.max(0, (Date.parse(G.resetsAt ?? '') - now) / 60000) || 300)
  // Submitted from a timer: a prompt cannot be queued from inside the hook of the turn it follows.
  const text = aarPrompt(G.aar, G.used, G.est, resetIn, G.threads)
  $.clock.after(500, () => {
    void $.prompt.submit({ text }).catch(() => {
      G.phase = 'idle'
    })
  })
}

/** The AAR turn is done: learn its cost, then clear or keep the session and arm the resume. */
async function finishAar($: EngineInterface) {
  const now = await $.clock.now()
  const cwd = await $.session.cwd()
  const wrote = await $.fs.exists(G.aar).catch(() => false)
  if (!wrote) {
    G.phase = 'idle'
    $.ui.toast('AAR was not written; the limit guard is off until the next trip')
    return
  }
  const pct = (await read($, usage)).fiveHour?.pct
  if (pct !== undefined && pct > G.used) {
    const per = Math.min(8, Math.max(0.2, (pct - G.used) / G.threads))
    const old = await aarCost($)
    await $.store.set(STATE_KEY, old + 0.5 * (per - old))
  }
  const plan = planResume(now, G.resetsAt)
  const pending: Pending = {
    aar: G.aar,
    cwd,
    resumeAt: plan.resumeAt,
    cleared: plan.clear,
    oldSession: await $.session.id(),
  }
  G.pending = pending
  G.phase = 'waiting'
  await $.store.set(storeKey(cwd), pending)
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
async function checkResume($: EngineInterface) {
  if (G.phase !== 'waiting' || !G.pending) return
  const now = await $.clock.now()
  const p = G.pending
  if (now < p.resumeAt) return
  G.phase = 'idle'
  G.pending = undefined
  await $.store.delete(storeKey(p.cwd))
  void $.prompt.submit({ text: resumePrompt(p.aar, p.cleared) }).catch(() => undefined)
  // Never move the transcript of the session that is running now (e.g. one resumed with --resume).
  if (p.cleared && p.oldSession && p.oldSession !== (await $.session.id())) {
    // Old sessions are moved to ~/archive/_review/<date>/ (manifest), never deleted outright.
    void $.process
      .run(['sh', '-c', purgeScript, 'sh', p.oldSession, p.aar], { timeoutMs: 20000 })
      .catch(() => undefined)
  }
}

/** Turns the guard off now: drops the pause, the saved resume and the shared trip. */
async function release($: EngineInterface, why: string) {
  const cwd = await $.session.cwd()
  G.phase = 'idle'
  G.armed = false
  G.pending = undefined
  await $.store.delete(storeKey(cwd))
  await $.store.delete(TRIP_KEY)
  $.ui.toast(`Limit guard released: ${why}`)
}

/**
 * A fresh reading from a new window (a reset, or another account) ends a stale
 * guard: a pause with an AAR resumes from it now; a drain or AAR request stops.
 */
async function maybeRelease($: EngineInterface, usedPct: number, resetsAt: string | undefined) {
  if (G.phase === 'idle' || !windowFresh(usedPct)) return
  const now = await $.clock.now()
  if (resetsAt && Date.parse(resetsAt) <= now) return // stale reading: wait for the next one
  if (G.phase === 'waiting' && G.pending) {
    G.pending = { ...G.pending, resumeAt: now }
    await $.store.delete(TRIP_KEY)
    $.ui.toast(`5h window at ${usedPct.toFixed(0)}%: resuming from the AAR now`)
    await checkResume($)
    return
  }
  await release($, `5h window at ${usedPct.toFixed(0)}%`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ensure($)
    S.mark = { t: await $.clock.now(), tok: 0 }
    S.todos = []
    await $.command.register({
      name: 'eta',
      description: 'Show usage limits, tasks and the ETA estimator (/eta override releases the limit guard)',
    })
    void $.ui.open({ id: PANE, title: 'Usage & ETA' })
    $.clock.every(30000, () => {
      $.ui.invalidate('ui.render')
      void (async () => {
        await heartbeat($)
        await checkResume($)
        await advanceDrain($)
        await maybeTrigger($)
      })().catch(() => undefined)
    })
    // A restart while waiting for the reset: pick the pending resume back up.
    const saved = (await $.store.get(storeKey(await $.session.cwd()))) as Pending | undefined
    if (saved?.aar && G.phase === 'idle') {
      G.pending = { ...saved, cleared: true, oldSession: saved.oldSession }
      G.phase = 'waiting'
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const agentId = (e as { agentId?: string }).agentId
    if (!agentId) {
      G.turnId = e.turnId
      G.running = true
      if (G.phase === 'writing' && e.text.includes(MARKER)) G.armed = true
    }
    return next(e)
  })

  on('command.run', { command: 'eta' }, async ($, e) => {
    if (e.args.trim() === 'override') {
      const was = G.phase
      if (was === 'idle') return { text: 'usage-eta: the limit guard is not active' }
      const resetsAt = Date.parse((await read($, usage)).fiveHour?.resetsAt ?? '')
      const now = await $.clock.now()
      G.holdUntil = Number.isFinite(resetsAt) && resetsAt > now ? resetsAt : now + 5 * 3600_000
      await release($, 'overridden with /eta override')
      return { text: `usage-eta: limit guard released (was ${was}); tools are allowed again` }
    }
    await $.ui.open({ id: PANE, title: 'Usage & ETA' })
    return { text: await summary($) }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, ETA_RULE] }
  })

  on('prompt.submit', async ($, e, next) => {
    S.mark = { t: await $.clock.now(), tok: (await read($, usage)).tokens }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (G.phase !== 'idle') {
      const dir = aarDirOf(G.aar || G.pending?.aar || '')
      const agentId = (e as { agentId?: string }).agentId
      if (!toolAllowed(G.phase, tool, e as unknown as { file_path?: string; command?: string }, dir)) {
        return { deny: denyText(G.phase, !!agentId, dir, agentId ?? '') }
      }
    }
    if (tool === 'Agent') {
      const input = e as unknown as { subagent_type?: string; description?: string }
      const id = e.tool_use_id ?? ''
      const isNew =
        id !== '' &&
        (await startStep($, id, input.subagent_type ?? 'general-purpose', input.description ?? ''))
      const ran = await next(e)
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
    const isNew =
      e.tool_use_id !== '' && (await startStep($, e.tool_use_id, e.subagentType, e.description))
    const ran = await next(e)
    if (isNew) await endStep($, e.tool_use_id)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    if (r.usage) {
      const eff = effective(r.usage)
      S.tokSincePct += eff
      await update($, usage, u => ({ ...u, tokens: u.tokens + eff }))
    }
    const isMain = !(e as { agentId?: string }).agentId
    const run = await read($, egm)
    if (isMain && run && !run.doneAt && run.steps.every(s => s.doneAt)) {
      const finished = { ...run, doneAt: now }
      await update($, egm, () => finished)
      S.model = learnEgm(S.model, finished, now)
      await save($)
    }
    if (isMain) await reconcile($)
    await refreshStatus($)
    if (isMain) {
      G.running = false
      if (G.phase === 'writing' && G.armed) await finishAar($)
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
      if (S.lastPct !== undefined && five.percentUsed > S.lastPct) {
        S.model = learnRate(S.model, five.percentUsed - S.lastPct, S.tokSincePct)
        S.tokSincePct = 0
        await save($)
      }
      if (S.lastPct === undefined || five.percentUsed < S.lastPct) S.tokSincePct = 0
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
    const f = forecast(t, g, u, S.model, now)
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
            Limit guard: {G.phase === 'draining' ? 'finishing running work' : G.phase === 'writing' ? 'writing the AAR' : `paused, resumes ${G.pending?.cleared ? 'after /clear ' : ''}at ${new Date(G.pending?.resumeAt ?? now).toLocaleTimeString()}`}
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
                ○ {type.replace('egm:', '')} · est {fmtMin(S.model.egm[g.skill]?.agentMin[type] ?? 3)}
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
      </Box>
    )
  })
}
