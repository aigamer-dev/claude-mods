import { expect, test } from 'claude-code/testing'

import { applyTool, blank, correction, forecast, learnTask, splitEta, syncTodos } from './estimator'

const PANE = {
  plugin: 'usage-eta',
  component: 'Pane',
  requestId: 'usage-eta',
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
