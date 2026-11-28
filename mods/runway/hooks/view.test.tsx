import { expect, test } from 'claude-code/testing'

import { chain } from './agents.test.helpers'
import { agentRows } from './agents'
import { buildView, clip, COMPACT_BELOW, levelColor, statusLine } from './view'
import type { ViewModel } from './view'

const NOW = 1_700_000_000_000
const MIN = 60_000

const base = (over: Partial<ViewModel> = {}): ViewModel => ({
  cols: 80,
  now: NOW,
  five: { pct: 62, resetsAt: new Date(NOW + 72 * MIN).toISOString() },
  week: { pct: 41 },
  estPct: 9,
  agents: [],
  tasks: [],
  session: { tokens: 1_200_000, usd: 3.2 },
  model: { n: 12, correction: 1.4, mape: 0.2, tokPerMin: 9000, pctPerMtok: 4.5, learning: false, nAll: 12, nTurn: 30, nAgent: 8, nRate: 6 },
  ...over,
})

const text = (l: { t: string }[]) => l.map(s => s.t).join('')
const plain = (m: ViewModel) => buildView(m).map(text)

test('limit colours go green, yellow, red as a limit fills', () => {
  expect([levelColor(10), levelColor(70), levelColor(95)]).toEqual(['green', 'yellow', 'red'])
})

test('no line is ever wider than the pane, at any width', () => {
  const m = base({
    tasks: [
      { text: 'A very long task description that goes on and on and on and on', status: 'in_progress', estMin: 20, spentMin: 31 },
      { text: 'Another long pending task with many words in it, also very long', status: 'pending', estMin: 7, eta: 5 },
    ],
    agents: [{ id: 'a', type: 'egm:egm-synthesizer', label: 'a long description of what it does', depth: 2, since: NOW - 4 * MIN }],
    forecast: { remainingMin: 120, lowMin: 80, highMin: 200, tokens: 900_000, pctNeeded: 18, fits: false, reason: 'needs 18% of the 5h limit but only 12% is left before the reset' },
    guard: { phase: 'waiting', manual: false, resumeAt: NOW + 3 * 60 * MIN },
  })
  for (const cols of [24, 30, 40, 46, 60, 80, 120]) {
    for (const l of buildView({ ...m, cols })) expect(text(l).length).toBeLessThanOrEqual(cols)
  }
})

test('the 5h bar shows used, estimated and unused cells, and grows with the pane', () => {
  const narrow = buildView(base({ cols: 40 }))[1]!
  const wide = buildView(base({ cols: 100 }))[1]!
  const cells = (l: { t: string }[], c: string) => l.filter(s => s.t.startsWith(c)).reduce((n, s) => n + s.t.length, 0)
  expect(cells(wide, '█') + cells(wide, '░')).toBeGreaterThan(cells(narrow, '█') + cells(narrow, '░'))
  expect(text(wide)).toContain('62%')
  expect(text(wide)).toContain('+9%')
  expect(text(wide)).toContain('↻1h12m')
})

test('both limit bars have the same width at every pane width', () => {
  for (const cols of [30, 40, 60, 100]) {
    const [five, week] = buildView(base({ cols })).slice(1, 3)
    const cells = (l: { t: string }[]) => l.filter(s => /^[█░]/.test(s.t)).reduce((n, s) => n + s.t.length, 0)
    expect(cells(five!)).toBe(cells(week!))
  }
})

test('a narrow pane drops the secondary detail', () => {
  const wide = plain(base({ cols: 80 })).join('\n')
  const narrow = plain(base({ cols: COMPACT_BELOW - 1 })).join('\n')
  expect(wide).toContain('rate readings')
  expect(narrow).not.toContain('rate readings')
  expect(narrow).toContain('Learned from')
})

test('the guard banner says what it is doing, with a countdown to the resume', () => {
  const g = (guard: ViewModel['guard']) => plain(base({ guard })).join('\n')
  expect(g({ phase: 'draining', manual: false, since: NOW - 2 * MIN })).toContain('finishing running work (2m)')
  expect(g({ phase: 'writing', manual: false })).toContain('writing the AAR')
  expect(g({ phase: 'waiting', manual: true })).toContain('Paused by you')
  expect(g({ phase: 'waiting', manual: false, resumeAt: NOW + 90 * MIN })).toContain('resumes in 1h30m')
  expect(g(undefined)).not.toContain('Guard')
})

test('agents are drawn as a tree with their depth, and a deep tree is capped', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, type: 'general-purpose', depth: i, since: NOW - i * MIN }))
  const out = plain(base({ agents: rows }))
  const joined = out.join('\n')
  expect(joined).toContain('Agents')
  expect(joined).toContain('12 running · 12 deep')
  expect(joined).toContain('… +4 more agents') // 8 rows shown
  expect(out.some(l => l.includes('└ general-purpose'))).toBe(true)
  const deep = plain(base({ agents: rows.slice(0, 8), cols: 100 })).find(l => l.includes('⋯'))
  expect(deep).toBeDefined() // beyond the indent limit
})

test('agentRows lists parents before children at any depth, children by start time', () => {
  const t = chain(10)
  const rows = agentRows(t, 1_000_000)
  expect(rows.map(r => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `a${i}`))
  expect(rows.map(r => r.depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test('the task list shows progress, groups by status and folds earlier finished tasks', () => {
  const done = (n: number) => ({ text: `done ${n}`, status: 'completed' as const, estMin: 5, spentMin: n % 2 ? 9 : 3 })
  const out = plain(
    base({
      tasks: [done(1), done(2), done(3), done(4), done(5), { text: 'now', status: 'in_progress', estMin: 10, spentMin: 4 }, { text: 'later', status: 'pending', estMin: 6 }],
    }),
  )
  expect(out.find(l => l.startsWith('Tasks'))).toContain('5/7')
  expect(out.join('\n')).toContain('… 2 earlier done')
  expect(out.join('\n')).not.toContain('done 1')
  expect(out.join('\n')).toContain('▶ now · 4m of ~10m')
  const first = out.findIndex(l => l.includes('▶ now'))
  const pend = out.findIndex(l => l.includes('○ later'))
  const fin = out.findIndex(l => l.includes('✔ done 5'))
  expect(first).toBeLessThan(pend)
  expect(pend).toBeLessThan(fin) // active, then pending, then finished
})

test('a finished task shows over or under its estimate', () => {
  const out = plain(
    base({
      tasks: [
        { text: 'slow one', status: 'completed', estMin: 5, spentMin: 9 },
        { text: 'quick one', status: 'completed', estMin: 8, spentMin: 3 },
      ],
    }),
  )
  expect(out.join('\n')).toContain('slow one · 9m +4m')
  expect(out.join('\n')).toContain('quick one · 3m -5m')
})

test('an empty task list keeps its message', () => {
  expect(plain(base()).join('\n')).toContain('No todo list yet.')
})

test('the forecast says fits or will not fit, with the ETA range and the reason', () => {
  const f = (fits: boolean) => plain(base({ forecast: { remainingMin: 25, lowMin: 18, highMin: 40, tokens: 120_000, pctNeeded: 9, fits, reason: 'plenty of room' } })).join('\n')
  expect(f(true)).toContain('✔ Fits · ETA 25m (18m–40m)')
  expect(f(false)).toContain('✘ Will not fit')
  expect(f(true)).toContain('plenty of room')
  expect(plain(base()).join('\n')).toContain('Nothing left to estimate.')
})

test('the status line is compact and carries the guard marker, reset, week and verdict', () => {
  const m = base({ forecast: { remainingMin: 25, lowMin: 18, highMin: 40, tokens: 120_000, pctNeeded: 9, fits: true, reason: '' } })
  expect(statusLine(m)).toBe('5h ████░░ 62% ↻1h12m · wk 41% · ETA 25m · ~120k tok · ✔ fits')
  expect(statusLine({ ...m, guard: { phase: 'waiting', manual: false } }).startsWith('‖ 5h')).toBe(true)
  expect(statusLine({ ...m, five: undefined, week: undefined, forecast: undefined })).toBe('5h --')
  expect(statusLine({ ...m, forecast: { ...m.forecast!, fits: false } })).toContain("✘ WON'T FIT")
})

test('clip ends a cut line with an ellipsis and leaves a short one alone', () => {
  const l = [{ t: 'abcdef' }, { t: 'ghij', dim: true }]
  expect(text(clip(l, 20))).toBe('abcdefghij')
  expect(text(clip(l, 8))).toBe('abcdefg…')
})

test('a reading whose window has reset is not drawn as a live percentage', () => {
  expect(plain(base({ five: undefined })).find(l => l.startsWith('5h'))).toContain('--')
  expect(statusLine({ ...base(), five: undefined, week: undefined, forecast: undefined })).toBe('5h --')
})

test('the guard symbols are one cell wide, so a narrow pane never wraps the banner', () => {
  for (const cols of [24, 30, 38]) {
    for (const guard of [{ phase: 'draining', manual: false, since: NOW }, { phase: 'waiting', manual: true }] as const) {
      for (const l of buildView(base({ cols, guard }))) expect(/[\u23F3\u23F8]/.test(text(l))).toBe(false)
    }
  }
})
