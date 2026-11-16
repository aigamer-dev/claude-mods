import { expect, mock, test } from 'claude-code/testing'

import { MARKER, RESUME_MARKER } from './guard'

const T0 = 1_700_000_000_000
const MIN = 60_000

/** Boots the mod on a mocked world and records what the guard does. */
async function boot($: any, on: any, aarExists = true) {
  const clock = mock.clock(on, { now: T0 })
  const store: Record<string, unknown> = {}
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('store.delete', (_: any, e: any) => (delete store[e.key], { value: undefined }))
  const seen = { abort: [] as string[], submits: [] as string[], commands: [] as string[], procs: [] as string[][], toasts: [] as string[] }
  on('session.cwd', () => ({ value: '/work/proj' }))
  on('session.id', () => ({ value: 'old-session-id' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.exists', () => ({ value: aarExists }))
  on('turn.abort', (_: any, e: any) => (seen.abort.push(e.turnId), { value: undefined }))
  on('prompt.submit', (_: any, e: any) => (seen.submits.push(e.text), { text: e.text } as never))
  on('command.run', (_: any, e: any) => (seen.commands.push(e.command), { text: '' } as never))
  on('process.run', (_: any, e: any) => (seen.procs.push([...e.argv]), { value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', (_: any, e: any) => (seen.toasts.push(e.text), { value: undefined }))
  on('command.register', () => ({ value: { command: 'eta' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: 'Task #1 created successfully' }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }) as never)
  on('session.measure', () => ({ changed: ['rateLimits'] }) as never)
  on('turn.complete', (_: any, e: any) => ({ text: '', turnId: e.turnId }) as never)
  await $.session.start({ cwd: '/work/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Huge refactor (~180m)', description: 'x' })
  return { clock, store, seen }
}

const measure = ($: any, pct: number, resetInMin: number) =>
  $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt: new Date(T0 + resetInMin * MIN).toISOString() }],
    changed: ['rateLimits'],
  })
const startTurn = ($: any, turnId: string, text: string) => $.turn.start({ text, turnId })
const endTurn = ($: any, turnId: string) =>
  $.turn.complete({ turnId, reason: 'answer', answer: '', usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })

test('mock flow: 96% used + big estimate, reset in 3h -> AAR, clear, resume after reset, purge old session', async ($, on) => {
  const { clock, store, seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')

  // 1. trips: running turn stopped, AAR requested
  expect(seen.abort).toEqual(['t1'])
  expect(seen.submits).toHaveLength(1)
  expect(seen.submits[0]).toContain(MARKER)
  expect(seen.submits[0]).toContain('/work/proj/.claude/aar/AAR-')

  // a second reading while the AAR is being written must not trip again
  await measure($, 97, 180)
  expect(seen.submits).toHaveLength(1)

  // 2. AAR turn runs and completes -> pending resume saved, clear scheduled
  await startTurn($, 't2', seen.submits[0])
  await endTurn($, 't2')
  expect((store['resume:/work/proj'] as any).cleared).toBe(true)
  await clock.advance(2500)
  expect(seen.commands).toEqual(['clear'])

  // 3. before the reset: nothing resumes
  await clock.advance(170 * MIN)
  expect(seen.submits).toHaveLength(1)

  // 4. after the reset (+ slack): resume from the AAR in the fresh session, old session purged
  await clock.advance(11 * MIN)
  expect(seen.submits).toHaveLength(2)
  expect(seen.submits[1]).toContain(RESUME_MARKER)
  expect(seen.submits[1]).toContain('fresh session')
  expect(seen.procs.some(a => a.includes('old-session-id'))).toBe(true)
  expect(store['resume:/work/proj']).toBeUndefined()
})

test('mock flow: reset in 20 min keeps the session (cache warm) and resumes in place', async ($, on) => {
  const { clock, seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 20)
  await endTurn($, 't1')
  await startTurn($, 't2', seen.submits[0])
  await endTurn($, 't2')
  await clock.advance(5000)
  expect(seen.commands).toEqual([])
  await clock.advance(25 * MIN)
  expect(seen.submits).toHaveLength(2)
  expect(seen.submits[1]).toContain(RESUME_MARKER)
  expect(seen.submits[1]).not.toContain('fresh session')
  expect(seen.procs).toEqual([])
})

test('mock flow: below the thresholds the guard stays quiet', async ($, on) => {
  const { seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 80, 180) // 80 + ~11% est: under 95% used
  expect(seen.submits).toEqual([])
  await measure($, 95, 180); await endTurn($, 't1') // used 95 but est 95 + ~11 > 98 -> trips
  expect(seen.submits).toHaveLength(1)
})

test('mock flow: if the AAR file is missing the guard backs off and does not clear', async ($, on) => {
  const { clock, seen } = await boot($, on, false)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')
  await startTurn($, 't2', seen.submits[0])
  await endTurn($, 't2')
  await clock.advance(5000)
  expect(seen.commands).toEqual([])
  expect(seen.toasts.some(t => /not written/.test(t))).toBe(true)
})
