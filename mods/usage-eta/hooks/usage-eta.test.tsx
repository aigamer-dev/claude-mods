import { expect, test } from 'claude-code/testing'

import { blank, correction, forecast, learnTask, splitEta } from './estimator'

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
