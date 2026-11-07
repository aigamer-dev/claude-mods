import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EgmRun, Task, Usage } from '../types'
import {
  bar,
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
} from './estimator'
import type { Model } from './estimator'

const PANE = 'usage-eta'
const tasks = atom({ plugin: 'usage-eta', key: 'tasks' } as const, [], {
  shape: 'tasks-1',
})
const egm = atom({ plugin: 'usage-eta', key: 'egm' } as const, null, {
  shape: 'egm-1',
})
const usage = atom({ plugin: 'usage-eta', key: 'usage' } as const, { tokens: 0, usd: 0 }, {
  shape: 'usage-1',
})

const ETA_RULE = {
  id: 'usage-eta:eta',
  scope: 'session',
  text:
    'When you keep a todo list (TodoWrite), end every item\'s content with your honest time ' +
    'estimate in minutes, like "Write the parser (~12m)" or "(~1.5h)". The usage tracker ' +
    'compares it with the real time and calibrates future estimates. Keep item wording ' +
    'unchanged between updates so progress is matched.',
} as const

const effective = (u: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}) =>
  u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens

const skillName = (s: string) => s.replace(/^egm:/, '')

const S = {
  model: blank() as Model,
  loaded: false,
  mark: { t: 0, tok: 0 },
  tokSincePct: 0,
  lastPct: undefined as number | undefined,
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ensure($)
    S.mark = { t: await $.clock.now(), tok: 0 }
    await $.command.register({ name: 'eta', description: 'Show usage limits, tasks and the ETA estimator' })
    void $.ui.open({ id: PANE, title: 'Usage & ETA' })
    $.clock.every(30000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('command.run', { command: 'eta' }, async $ => {
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

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    await ensure($)
    const now = await $.clock.now()
    const u = await read($, usage)
    const prev = await read($, tasks)
    const todos = e.todos.map(t => ({ content: t.content, status: t.status }))
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
    const ran = await next(e)
    await refreshStatus($)
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
    const run = await read($, egm)
    if (!run || run.doneAt) return next(e)
    const step = { type: e.subagentType, label: e.description, startedAt: await $.clock.now() }
    await update($, egm, r => (r ? { ...r, steps: [...r.steps, step] } : r))
    const ran = await next(e)
    const end = await $.clock.now()
    await update($, egm, r =>
      r
        ? {
            ...r,
            steps: r.steps.map(s =>
              s.startedAt === step.startedAt && s.type === step.type && !s.doneAt
                ? { ...s, doneAt: end }
                : s,
            ),
          }
        : r,
    )
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
    await refreshStatus($)
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
    }
    await update($, usage, u => ({
      ...u,
      usd: e.cost?.usd ?? u.usd,
      fiveHour: five ? { pct: five.percentUsed, resetsAt: five.resetsAt } : u.fiveHour,
      week: week ? { pct: week.percentUsed, resetsAt: week.resetsAt } : u.week,
    }))
    await refreshStatus($)
    return next(e)
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

    return (
      <Box flexDirection="column">
        <Text bold>Limits</Text>
        <Text>
          5h   {bar(u.fiveHour?.pct ?? 0)} {u.fiveHour ? `${u.fiveHour.pct.toFixed(0)}%` : '--'}
          {reset(u.fiveHour)}
        </Text>
        <Text>
          Week {bar(u.week?.pct ?? 0)} {u.week ? `${u.week.pct.toFixed(0)}%` : '--'}
          {reset(u.week)}
        </Text>
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
