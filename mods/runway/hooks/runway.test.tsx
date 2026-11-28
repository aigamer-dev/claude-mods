import { expect, test } from 'claude-code/testing'

import { agentMinOf, applyTool, blank, correction, forecast, learnAgent, learnTask, learnTurn, splitEta, syncTodos } from './estimator'

const PANE = {
  plugin: 'runway',
  component: 'Pane',
  requestId: 'runway',
  props: {
    title: 'Usage & ETA',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('parses the model ETA off a todo', () => {
  expect(splitEta('Write parser (~12m)')).toEqual({ text: 'Write parser', eta: 12 })
  expect(splitEta('Big refactor ~1.5h').eta).toBe(90)
  expect(splitEta('No estimate').eta).toBeUndefined()
})

test('the estimator learns that the model is too optimistic', () => {
  let m = blank()
  for (let i = 0; i < 12; i++) m = learnTask(m, { eta: 5, actualMin: 10, tokens: 100000 })
  expect(correction(m)).toBeGreaterThan(1.6)
  expect(m.tokPerMin).toBeGreaterThan(9000)
  expect(m.tokPerMin).toBeLessThan(20000)
  expect(m.mape).toBeLessThan(0.3)
})

test('the forecast says when the work does not fit the window', () => {
  const m = blank()
  const tasks = [{ id: 'a', text: 'a', eta: 60, status: 'pending' as const }]
  const now = Date.now()
  const usage = {
    tokens: 0,
    usd: 0,
    fiveHour: { pct: 96, resetsAt: new Date(now + 3 * 3600e3).toISOString() },
  }
  const f = forecast(tasks, null, usage, m, now)
  expect(f.fits).toBe(false)
  const ok = forecast(tasks, null, { ...usage, fiveHour: { pct: 5, resetsAt: usage.fiveHour.resetsAt } }, { ...m, pctPerMtok: 1 }, now)
  expect(ok.fits).toBe(true)
})

test('the pane draws limits, tasks and the forecast', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No todo list yet/ }))?.text).toBe('No todo list yet.')
  await ui.unmount()
})

test('TaskCreate and TaskUpdate build and advance a list', () => {
  let l = applyTool([], 'TaskCreate', { subject: 'Parse (~5m)' }, 'Task #1 created successfully')
  l = applyTool(l, 'TaskCreate', { subject: 'Test (~3m)' }, 'Task #2 created successfully')
  l = applyTool(l, 'TaskUpdate', { taskId: '1', status: 'in_progress' })
  l = applyTool(l, 'TaskUpdate', { taskId: '1', status: 'completed' })
  l = applyTool(l, 'TaskUpdate', { taskId: '2', status: 'deleted' })
  expect(l.map(t => t.status)).toEqual(['completed'])
})

test('update_plan items and advance are followed', () => {
  let l = applyTool([], 'mcp__ccd_turn__update_plan', {
    items: [
      { content: 'A (~2m)', status: 'in_progress' },
      { content: 'B', status: 'pending' },
    ],
  })
  l = applyTool(l, 'mcp__ccd_turn__update_plan', { advance: true })
  expect(l.map(t => t.status)).toEqual(['completed', 'in_progress'])
})

test('a finished task is learned from, once', () => {
  const base = { t: 0, tok: 0 }
  const first = syncTodos([], [{ content: 'A (~2m)', status: 'in_progress' }], 1000, 0, base)
  const second = syncTodos(first.tasks, [{ content: 'A (~2m)', status: 'completed' }], 61000, 5000, base)
  expect(second.done).toHaveLength(1)
  const again = syncTodos(second.tasks, [{ content: 'A (~2m)', status: 'completed' }], 70000, 5000, base)
  expect(again.done).toHaveLength(0)
})

test('tasks created and finished inside one turn still teach the model', () => {
  const base = { t: 0, tok: 0 }
  const r = syncTodos(
    [],
    [
      { content: 'A (~2m)', status: 'completed' },
      { content: 'B (~2m)', status: 'completed' },
    ],
    600_000,
    100_000,
    base,
  )
  expect(r.done).toHaveLength(2)
  expect(r.done[0].doneAt).toBe(300_000)
  expect(r.done[1].startedAt).toBe(300_000)
  expect(r.done[1].tokDone).toBe(100_000)
  const again = syncTodos(r.tasks, [{ content: 'A (~2m)', status: 'completed' }], 700_000, 100_000, base)
  expect(again.done).toHaveLength(0)
  // a record that was already completed (older state with no time) is not learned from
  const old = syncTodos([{ id: 'A', text: 'A', status: 'completed' }], [{ content: 'A', status: 'completed' }], 700_000, 0, base)
  expect(old.done).toHaveLength(0)
})

test('the estimator stops saying it is learning after enough samples', () => {
  let m = blank()
  const tasks = [{ id: 'a', text: 'a', status: 'pending' as const }]
  const u = { tokens: 0, usd: 0 }
  expect(forecast(tasks, null, u, m, 0).isLearning).toBe(true)
  for (let i = 0; i < 5; i++) m = learnTask(m, { actualMin: 4, tokens: 80000 })
  m = { ...m, nRate: 3 }
  expect(forecast(tasks, null, u, m, 0).isLearning).toBe(false)
})

test('a TaskCreate call reaches the pane through the hooks', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'eta' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('clock.every', () => ({ value: () => {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: 'Task #1 created successfully' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write parser (~4m)', description: 'x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Write parser/ }))?.text).toMatch(/Write parser/)
  await ui.unmount()
})

import { COLD_MIN, planResume, shouldTrigger } from './guard'

test('the guard trips only at 95% used with an estimate over 98%', () => {
  expect(shouldTrigger(96, 5)).toBe(true)
  expect(shouldTrigger(96, 1)).toBe(false) // 97% total: still fits
  expect(shouldTrigger(90, 20)).toBe(false) // not yet at 95%
  expect(shouldTrigger(undefined, 50)).toBe(false)
})

test('a wait past 40 minutes clears the session, a short one keeps it', () => {
  const now = 1_700_000_000_000
  const at = (min: number) => new Date(now + min * 60000).toISOString()
  expect(planResume(now, at(COLD_MIN + 1)).clear).toBe(true)
  expect(planResume(now, at(COLD_MIN - 1)).clear).toBe(false)
  expect(planResume(now, at(10)).resumeAt).toBeGreaterThan(now + 10 * 60000)
})

test('turns and agent runs teach the model when the model never keeps a todo list', () => {
  let m = blank()
  const u = { tokens: 0, usd: 0 }
  expect(forecast([], null, u, m, 0).isLearning).toBe(true)
  for (let i = 0; i < 5; i++) m = learnTurn(m, { min: 4, tokens: 120000 })
  expect(m.nAll).toBe(0)
  expect(m.nTurn).toBe(5)
  expect(Math.round((m.turnMin) * 1000) / 1000).toBe(4)
  expect(m.tokPerMin).toBeGreaterThan(20000) // moved off the default toward 30000
  m = { ...m, nRate: 3 }
  expect(forecast([], null, u, m, 0).isLearning).toBe(false)
  // sub-6s turns are noise
  expect(learnTurn(m, { min: 0.05, tokens: 1000 })).toBe(m)
})

test('agent runs are learned per type, falling back to the overall average', () => {
  let m = blank()
  expect(agentMinOf(m, undefined, 'general-purpose')).toBe(3)
  m = learnAgent(m, 'Explore', 10)
  m = learnAgent(m, 'Explore', 10)
  m = learnAgent(m, 'worker', 2)
  expect(m.nAgent).toBe(3)
  expect(Math.round((agentMinOf(m, undefined, 'Explore')) * 1000) / 1000).toBe(10)
  expect(Math.round((agentMinOf(m, undefined, 'worker')) * 1000) / 1000).toBe(2)
  expect(agentMinOf(m, undefined, 'never-seen')).toBe(m.agentAvg)
  expect(learnAgent(m, 'Explore', 0.01)).toBe(m)
})

test('with enough turns the running turn is the forecast when there is no todo list', () => {
  const u = { tokens: 0, usd: 0 }
  let m = blank()
  for (let i = 0; i < 5; i++) m = learnTurn(m, { min: 6, tokens: 60000 })
  const none = forecast([], null, u, m, 10 * 60000)
  expect(none.pending).toBe(0)
  const f = forecast([], null, u, m, 10 * 60000, 8 * 60000) // 2 minutes into a 6 minute turn
  expect(f.pending).toBe(1)
  expect(Math.round((f.remainingMin) * 1000) / 1000).toBe(4)
  // too few turns: no guess
  expect(forecast([], null, u, blank(), 10 * 60000, 8 * 60000).pending).toBe(0)
})
