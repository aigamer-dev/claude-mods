import { expect, mock, test } from 'claude-code/testing'

import { withCommands, CMD_BEGIN, DRAIN_MAX_MS, MARKER, etaCompletions, MIN_TRIP_USED, RELEASE_BELOW_PCT, RESUME_MARKER, aarPath, mayAdopt, thresholds, toolAllowed } from './guard'

const T0 = 1_700_000_000_000
const MIN = 60_000

let CLK: any

/** The saved pause and the held prompts, whatever AAR path (the key) the cycle got. */
const rec = (st: Record<string, unknown>): any => Object.entries(st).find(([k]) => k.startsWith('resume:'))?.[1]
const cmdsOf = (st: Record<string, unknown>): any => Object.entries(st).find(([k]) => k.startsWith('guard:cmds:'))?.[1]

/** Boots the mod on a mocked world and records what the guard does. */
async function boot($: any, on: any, aarExists = true, cwd = '/work/proj') {
  const clock = mock.clock(on, { now: T0 })
  const store: Record<string, unknown> = {}
  on('store.get', (_: any, e: any) => {
    if (e.key === state.failKey) throw new Error('store busy')
    return { value: store[e.key] }
  })
  on('store.set', (_: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('store.delete', (_: any, e: any) => (delete store[e.key], { value: undefined }))
  const agents: any[] = []
  const listFails = { on: false }
  const seen = { abort: [] as string[], submits: [] as string[], commands: [] as string[], procs: [] as string[][], toasts: [] as string[] }
  on('agent.list', () => {
    if (listFails.on) throw new Error('list failed')
    return { value: agents }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('session.cwd', () => ({ value: cwd }))
  let sid = 'old-session-id'
  on('session.id', () => ({ value: sid }))
  on('session.messages', () => ({ value: [] }))
  const files: Record<string, string> = {}
  const state = { exists: aarExists, failSubmit: false, hang: false, unhang: [] as (() => void)[], failKey: '' }
  const listing: { name: string; kind: string }[] = []
  on('fs.list', () => ({ value: listing }))
  // A hung file check stays hung until `state.unhang` is called, then answers as a late reply would.
  on('fs.exists', () =>
    state.hang ? (new Promise(res => state.unhang.push(() => res({ value: state.exists }))) as any) : { value: state.exists },
  )
  on('fs.read', (_: any, e: any) => ({ value: files[e.path] ?? '# AAR\nNext steps: 1. build' }))
  on('fs.write', (_: any, e: any) => ((files[e.path] = e.text ?? e.content), { value: undefined }))
  on('turn.abort', (_: any, e: any) => (seen.abort.push(e.turnId), { value: undefined }))
  const spawned = { n: 0 }
  on('agent.spawn', () => ({ model: 'm', agentId: `spawned-${++spawned.n}` }) as never)
  on('prompt.submit', (_: any, e: any) => {
    if (state.failSubmit && e.text.includes(MARKER)) throw new Error('queue full')
    return (seen.submits.push(e.text), { text: e.text } as never)
  })
  on('command.run', (_: any, e: any) => {
    seen.commands.push(e.command)
    if (e.command === 'clear') sid = 'new-session-id' // /clear starts a new session
    return { text: '' } as never
  })
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
  on('turn.complete', (_: any, e: any) => ({ text: '', turnId: e.turnId, usage: e.usage }) as never)
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Huge refactor (~180m)', description: 'x' })
  CLK = clock
  return { clock, store, seen, agents, files, state, listing, spawned, listFails }
}

const measure = ($: any, pct: number, resetInMin: number) =>
  $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt: new Date(T0 + resetInMin * MIN).toISOString() }],
    changed: ['rateLimits'],
  })
const startTurn = ($: any, turnId: string, text: string) => $.turn.start({ text, turnId })
const endTurn = async ($: any, turnId: string) => {
  await $.turn.complete({ turnId, reason: 'answer', answer: '', usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  await CLK.advance(1000) // timers the hook armed (the AAR request goes out from one)
}

test('mock flow: 96% used, reset in 3h -> drain without aborting, AAR, clear, resume after reset, purge old session', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)

  // 1. trips into draining: nothing is aborted, new work is refused, the AAR files stay writable
  expect(seen.abort).toEqual([])
  expect(seen.submits).toEqual([])
  const denied: any = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(denied.deny).toContain('Usage guard')
  expect(((await $.tool.call({ tool: 'Write', file_path: '/etc/passwd', content: 'x' })) as any).deny).toContain('Usage guard')
  expect(((await $.tool.call({ tool: 'Write', file_path: '/work/proj/.claude/aar/x/../../../evil', content: 'x' })) as any).deny).toBeDefined()

  // 2. the running turn ends on its own -> the AAR is requested, once
  await endTurn($, 't1')
  expect(seen.submits).toHaveLength(1)
  expect(seen.submits[0]).toContain(MARKER)
  expect(seen.submits[0]).toContain('/work/proj/.claude/aar/')
  expect(seen.submits[0]).toContain('agent-*.md')
  await measure($, 97, 180)
  expect(seen.submits).toHaveLength(1)

  // 3. the AAR turn writes into the AAR folder, then completes -> resume saved, clear scheduled
  const aarFile = /(\/work\/proj\/\.claude\/aar\/[^ ]+\/AAR\.md)/.exec(seen.submits[0])![1]
  expect(((await $.tool.call({ tool: 'Write', file_path: aarFile, content: 'x' })) as any).deny).toBeUndefined()
  await startTurn($, 't2', seen.submits[0])
  await endTurn($, 't2')
  expect((rec(store) as any).cleared).toBe(true)
  await clock.advance(2500)
  expect(seen.commands).toEqual(['clear'])

  // 4. paused: even reads of the repo are the only thing allowed
  expect(((await $.tool.call({ tool: 'Write', file_path: aarFile, content: 'y' })) as any).deny).toContain('paused')

  // 5. before the reset nothing resumes; after it (+ slack) the fresh session resumes, old one purged
  await clock.advance(170 * MIN)
  expect(seen.submits).toHaveLength(1)
  await clock.advance(11 * MIN)
  expect(seen.submits).toHaveLength(2)
  expect(seen.submits[1]).toContain(RESUME_MARKER)
  expect(seen.submits[1]).toContain('fresh session')
  expect(seen.procs.some(a => a.includes('old-session-id'))).toBe(true)
  expect(rec(store)).toBeUndefined()
})

test('mock flow: running subagents are told to checkpoint, not killed; the AAR waits for them', async ($, on) => {
  const { clock, seen, agents } = await boot($, on)
  agents.push({ id: 'a1abcdef-1', type: 'general-purpose', status: 'running', description: 'review' })
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1') // main loop idle, but the subagent still runs
  expect(seen.abort).toEqual([])
  expect(seen.submits).toEqual([]) // no AAR yet

  // the subagent's next tool call is refused with its checkpoint instructions; its checkpoint write passes
  const d: any = await $.tool.call({ tool: 'Bash', command: 'make build', agentId: 'a1abcdef-1' })
  expect(d.deny).toContain('checkpoint')
  expect(d.deny).toContain('agent-a1abcdef.md')
  const ok: any = await $.tool.call({ tool: 'Write', file_path: d.deny.match(/(\/work\/proj\/\S+agent-a1abcdef\.md)/)[1], content: 'cp', agentId: 'a1abcdef-1' })
  expect(ok.deny).toBeUndefined()

  // it finishes; the next tick writes the AAR
  agents.length = 0
  await clock.advance(31_000)
  expect(seen.submits).toHaveLength(1)
  expect(seen.submits[0]).toContain(MARKER)
})

test('mock flow: a subagent that never ends does not block the AAR past the drain limit', async ($, on) => {
  const { clock, seen, agents } = await boot($, on)
  agents.push({ id: 'stuck-agent-1', type: 'general-purpose', status: 'running', description: 'x' })
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')
  await clock.advance(DRAIN_MAX_MS - 60_000)
  expect(seen.submits).toEqual([])
  await clock.advance(2 * 60_000)
  expect(seen.submits).toHaveLength(1)
})

test('mock flow: more live sessions and threads trip the guard earlier', async ($, on) => {
  const { store, seen } = await boot($, on)
  // alone, 90% used is under the 95% line
  await startTurn($, 't1', 'keep working')
  await measure($, 90, 180)
  await endTurn($, 't1')
  expect(seen.submits).toEqual([])
  // another live session with 4 threads: 5 AARs must fit in the same window
  store['live:other-session'] = { t: T0, threads: 4, cwd: '/other' }
  await startTurn($, 't3', 'more work')
  await measure($, 91, 180)
  await endTurn($, 't3')
  expect(seen.submits).toHaveLength(1)
  expect(seen.submits[0]).toContain('5 thread(s)')
})

test('mock flow: a trip in another session trips this one in the same window', async ($, on) => {
  const { clock, store, seen } = await boot($, on)
  store['guard:trip'] = { resetsAt: new Date(T0 + 3 * 60 * MIN).toISOString(), at: T0 }
  await clock.advance(31_000)
  expect(seen.submits).toHaveLength(1)
  expect(seen.submits[0]).toContain(MARKER)
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
  await measure($, 80, 180)
  await endTurn($, 't1')
  expect(seen.submits).toEqual([])
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined()
})

test('mock flow: a Windows cwd writes the AAR with backslashes and mixed case, mkdir and git -C are allowed', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, seen } = await boot($, on, true, 'C:\\Users\\Me\\proj')
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')
  const aar = /(C:\/Users\/Me\/proj\/\.claude\/aar\/[^ ]+\/AAR\.md)/.exec(seen.submits[0])![1]
  expect(aar).not.toContain('\\')
  await startTurn($, 't2', seen.submits[0])
  const dir = aar.replace(/\/AAR\.md$/, '')
  const back = (p: string) => p.replace(/\//g, '\\')
  const ok = async (input: any) => ((await $.tool.call(input)) as any).deny === undefined
  expect(await ok({ tool: 'Write', file_path: aar, content: 'x' })).toBe(true)
  expect(await ok({ tool: 'Write', file_path: back(aar), content: 'x' })).toBe(true)
  expect(await ok({ tool: 'Write', file_path: back(aar).replace('C:', 'c:'), content: 'x' })).toBe(true)
  expect(await ok({ tool: 'Edit', file_path: '/c' + dir.slice(2) + '/agent-12345678.md', old_string: 'a', new_string: 'b' })).toBe(true)
  expect(await ok({ tool: 'Bash', command: `mkdir -p "${dir}"` })).toBe(true)
  expect(await ok({ tool: 'PowerShell', command: `New-Item -ItemType Directory -Force -Path "${back(dir)}"` })).toBe(true)
  expect(await ok({ tool: 'Bash', command: 'git -C C:/Users/Me/proj status' })).toBe(true)
  expect(await ok({ tool: 'PowerShell', command: 'Get-ChildItem C:\\Users\\Me\\proj' })).toBe(true)
  // still refused: outside the folder, traversal out of it, other dirs, writes through the shell
  expect(await ok({ tool: 'Write', file_path: 'C:\\Users\\Me\\proj\\src\\a.ts', content: 'x' })).toBe(false)
  expect(await ok({ tool: 'Write', file_path: back(dir) + '\\..\\..\\..\\..\\evil.txt', content: 'x' })).toBe(false)
  expect(await ok({ tool: 'Bash', command: 'mkdir -p C:/Users/Me/proj/src' })).toBe(false)
  expect(await ok({ tool: 'PowerShell', command: 'Remove-Item -Recurse C:\\Users\\Me\\proj' })).toBe(false)
  expect(await ok({ tool: 'Bash', command: 'ls; rm -rf /' })).toBe(false)
  await endTurn($, 't2')
  await clock.advance(1000)
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
  // no retry loop: the next readings do not trip it again until the hold passes
  await startTurn($, 't3', 'keep working')
  await measure($, 97, 180)
  await endTurn($, 't3')
  expect(seen.submits).toHaveLength(1)
})

test('mock flow: a fresh low reading (reset or another account) resumes a stale pause at once', async ($, on) => {
  const { clock, store, seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')
  await startTurn($, 't2', seen.submits[0])
  await endTurn($, 't2')
  await clock.advance(2500)
  expect(((await $.tool.call({ tool: 'Bash', command: 'ls' })) as any).deny).toContain('paused')
  // the account changes: the new window reads 3%, long before the old reset
  await measure($, 3, 290)
  expect(seen.submits).toHaveLength(2)
  expect(seen.submits[1]).toContain(RESUME_MARKER)
  expect(rec(store)).toBeUndefined()
  expect(store['guard:trip']).toBeUndefined()
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined()
})

test('mock flow: a stale shared trip does not trip a session whose window is fresh', async ($, on) => {
  const { clock, store, seen } = await boot($, on)
  store['guard:trip'] = { resetsAt: new Date(T0 + 3 * 60 * MIN).toISOString(), at: T0 }
  await measure($, 3, 290)
  await clock.advance(31_000)
  expect(seen.submits).toEqual([])
  expect(store['guard:trip']).toBeUndefined()
})

test('/eta override releases a paused guard and its saved state', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')
  await startTurn($, 't2', seen.submits[0])
  await endTurn($, 't2')
  await clock.advance(2500)
  expect(rec(store)).toBeDefined()
  const r: any = await $.command.run({ command: 'eta', args: 'override' })
  expect(r.text).toContain('released')
  expect(rec(store)).toBeUndefined()
  expect(store['guard:trip']).toBeUndefined()
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined()
  // and nothing resumes later on its own
  await clock.advance(200 * MIN)
  expect(seen.submits).toHaveLength(1)
})

test('/eta override holds the guard off in every session until the window resets', { timeoutMs: 60_000 }, async ($, on) => {
  const { store, seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')
  expect(seen.submits).toHaveLength(1)
  const r: any = await $.command.run({ command: 'eta', args: 'override' })
  expect(r.text).toContain('released')
  expect((store['guard:hold'] as any).until).toBeGreaterThan(T0)
  // the guard does not trip again on the next readings
  await startTurn($, 't3', 'keep working')
  await measure($, 97, 180)
  await endTurn($, 't3')
  expect(seen.submits).toHaveLength(1)
  // override also works before the guard has tripped
  const again: any = await $.command.run({ command: 'eta', args: 'override' })
  expect(again.text).toContain('held off')
  const back: any = await $.command.run({ command: 'eta', args: 'guard on' })
  expect(back.text).toContain('on again')
  expect(store['guard:hold']).toBeUndefined()
})

test('rate learning keeps the task samples other sessions saved', { timeoutMs: 60_000 }, async ($, on) => {
  const { store } = await boot($, on)
  store['model'] = { n: 7, nAll: 9, logRatio: 0.2, mape: 0.3, avgTaskMin: 6, tokPerMin: 30000, pctPerMtok: 6, nRate: 1, egm: {} }
  await startTurn($, 't1', 'work')
  await measure($, 10, 180)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', usage: { input_tokens: 40000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  await measure($, 12, 180)
  const m: any = store['model']
  expect(m.nRate).toBe(2)
  expect(m.n).toBe(7)
  expect(m.nAll).toBe(9)
})

/** Gets the guard into its paused (waiting) phase with the AAR written. */
async function pause($: any, on: any, cwd = '/work/proj') {
  const w = await boot($, on, true, cwd)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')
  await startTurn($, 't2', w.seen.submits[0])
  await endTurn($, 't2')
  await w.clock.advance(2500)
  return w
}

test('a prompt typed while the guard is active is held, saved and put on top of the AAR (no model call)', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen, files } = await pause($, on)
  const before = seen.submits.length
  const r: any = await $.prompt.submit({ text: 'also add retry logic\nand a test', origin: { kind: 'composer' }, wait: false } as any)
  expect(r.drop).toContain('AAR')
  expect(seen.submits.length).toBe(before) // nothing reached the model
  const cmds = cmdsOf(store) as any[]
  expect(cmds).toHaveLength(1)
  expect(cmds[0].text).toBe('also add retry logic\nand a test')
  // statically written on top of the AAR, the model's text kept below
  const aar = Object.keys(files)[0]
  const text = files[aar]
  expect(text.startsWith(CMD_BEGIN)).toBe(true)
  expect(text).toContain('> also add retry logic')
  expect(text).toContain('> and a test')
  expect(text).toContain('Next steps: 1. build')
  // a second one replaces the block rather than stacking another
  await $.prompt.submit({ text: 'and update the docs', origin: { kind: 'composer' }, wait: false } as any)
  expect(files[aar].split(CMD_BEGIN).length).toBe(2)
  expect(files[aar]).toContain('2. [')
  // the resume tells the model to take them first, and the ledger is cleared
  await clock.advance(200 * MIN)
  expect(seen.submits.at(-1)).toContain(RESUME_MARKER)
  expect(seen.submits.at(-1)).toContain('held')
  expect(cmdsOf(store)).toBeUndefined()
})

test('prompts held before the AAR exists are added to it when it is written', async ($, on) => {
  const { store, seen, files, state } = await boot($, on, false)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  // draining: the AAR does not exist yet
  const r: any = await $.prompt.submit({ text: 'do the thing', origin: { kind: 'composer' }, wait: true } as any)
  expect(r.drop).toBeDefined()
  expect(Object.keys(files)).toEqual([])
  await endTurn($, 't1')
  await startTurn($, 't2', seen.submits[0])
  state.exists = true // the model wrote the AAR during its turn
  await endTurn($, 't2')
  const aar = Object.keys(files)[0]
  expect(files[aar]).toContain('> do the thing')
  expect(aar.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')).toBe((rec(store) as any).aar)
})

test('the guard does not hold its own prompts or other plugins', async ($, on) => {
  const { seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  const other: any = await $.prompt.submit({ text: 'notification', origin: { kind: 'task-notification' }, wait: false } as any)
  expect(other.drop).toBeUndefined()
  await endTurn($, 't1')
  expect(seen.submits.some(t => t.includes(MARKER))).toBe(true) // the AAR request itself went through
})

test('/eta bypass runs one prompt with the guard lifted, then the guard is back', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen, files } = await pause($, on)
  const denied: any = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(denied.deny).toContain('paused')
  const none: any = await $.command.run({ command: 'eta', args: 'bypass' })
  expect(none.text).toContain('the syntax is')
  const r: any = await $.command.run({ command: 'eta', args: 'bypass fix the build' })
  expect(r.text).toContain('lifted')
  await clock.advance(1000)
  expect(seen.submits.at(-1)).toBe('fix the build')
  await startTurn($, 't9', 'fix the build')
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined()
  expect(((await $.tool.call({ tool: 'Write', file_path: '/work/proj/src/a.ts', content: 'x' })) as any).deny).toBeUndefined()
  await endTurn($, 't9')
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toContain('paused')
  // the bypassed prompt is noted on the AAR as run, not as pending
  const aar = Object.keys(files)[0]
  expect(files[aar]).toContain('ran under /eta bypass')
  expect(files[aar]).toContain('> fix the build')
  expect(rec(store)).toBeDefined() // still paused for the reset
})

test('/eta override gives back the prompts that were held', async ($, on) => {
  const { store } = await pause($, on)
  await $.prompt.submit({ text: 'ship it', origin: { kind: 'composer' }, wait: false } as any)
  const r: any = await $.command.run({ command: 'eta', args: 'override' })
  expect(r.text).toContain('ship it')
  expect(cmdsOf(store)).toBeUndefined()
})

test('a resume never moves the transcript of the running session', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')
  await startTurn($, 't2', seen.submits[0])
  await endTurn($, 't2')
  // the clear is never run here, so the session id stays the same
  seen.commands.length = 0
  await clock.advance(200 * MIN)
  expect(seen.submits).toHaveLength(2)
  expect(seen.procs.some(a => a.includes('old-session-id'))).toBe(seen.commands.includes('clear'))
})

test('/eta resume continues from the AAR at once, after a manual reset or an account switch', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen } = await pause($, on)
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toContain('paused')
  expect(seen.submits).toHaveLength(1)
  const r: any = await $.command.run({ command: 'eta', args: 'resume' })
  expect(r.text).toContain('resuming from the AAR')
  await clock.advance(1000)
  // the same resume prompt the timer would have sent, hours before the reset
  expect(seen.submits).toHaveLength(2)
  expect(seen.submits[1]).toContain(RESUME_MARKER)
  expect(rec(store)).toBeUndefined()
  expect(store['guard:trip']).toBeUndefined()
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined()
  // the old window's 96% reading is gone, so the next turn does not trip the guard again
  await startTurn($, 't5', seen.submits[1])
  await endTurn($, 't5')
  expect(seen.submits).toHaveLength(2)
  // nothing fires a second time when the original reset time comes
  await clock.advance(200 * MIN)
  expect(seen.submits).toHaveLength(2)
})

test('/eta resume sends the held prompts on top of the AAR, like the timer does', async ($, on) => {
  const { clock, store, seen } = await pause($, on)
  await $.prompt.submit({ text: 'ship it', origin: { kind: 'composer' }, wait: false } as any)
  await $.command.run({ command: 'eta', args: 'resume' })
  await clock.advance(1000)
  expect(seen.submits.at(-1)).toContain(RESUME_MARKER)
  expect(seen.submits.at(-1)).toContain('held')
  expect(cmdsOf(store)).toBeUndefined()
})

test('/eta resume finds the newest AAR on disk after /eta override dropped the saved pause', async ($, on) => {
  const { clock, seen, listing } = await pause($, on)
  const aar = /(\/work\/proj\/\.claude\/aar\/[^ ]+\/AAR\.md)/.exec(seen.submits[0])![1]
  await $.command.run({ command: 'eta', args: 'override' })
  listing.push({ name: '2020-01-01T00-00-00', kind: 'dir' }, { name: aar.split('/').at(-2)!, kind: 'dir' }, { name: 'notes.txt', kind: 'file' })
  const r: any = await $.command.run({ command: 'eta', args: 'resume' })
  expect(r.text).toContain(aar)
  await clock.advance(1000)
  expect(seen.submits.at(-1)).toContain(RESUME_MARKER)
  expect(seen.submits.at(-1)).toContain(aar)
  expect(seen.submits.at(-1)).not.toContain('fresh session')
})

test('/eta resume with no AAR says so; mid-drain it releases the guard', async ($, on) => {
  const { seen, state } = await boot($, on, false)
  const none: any = await $.command.run({ command: 'eta', args: 'resume' })
  expect(none.text).toContain('no AAR found')
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toContain('Usage guard')
  const r: any = await $.command.run({ command: 'eta', args: 'resume' })
  expect(r.text).toContain('released')
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined()
  await endTurn($, 't1')
  expect(seen.submits).toEqual([])
  expect(state.exists).toBe(false)
})

test('turns teach the shared model with no todo list, so it leaves the learning phase', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store } = await boot($, on)
  for (let i = 0; i < 6; i++) {
    await startTurn($, `L${i}`, 'work on it')
    await clock.advance(2 * MIN)
    await $.turn.complete({ turnId: `L${i}`, reason: 'answer', answer: '', usage: { input_tokens: 40000, output_tokens: 20000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  }
  const m: any = store['model']
  expect(m.nTurn).toBe(6)
  expect(m.turnMin).toBeGreaterThan(1.5)
  expect(m.turnMin).toBeLessThan(2.5)
  expect(m.tokPerMin).toBeGreaterThan(20000)
  // the guard's own turns are not learned from
  await startTurn($, 'AAR', `${MARKER} write it`)
  await clock.advance(MIN)
  await $.turn.complete({ turnId: 'AAR', reason: 'answer', answer: '', usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  expect((store['model'] as any).nTurn).toBe(6)
})

test('/eta pause saves an AAR with no limit trip, holds through resets and resumes only on /eta resume', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 20, 180) // far from any limit
  const r: any = await $.command.run({ command: 'eta', args: 'pause' })
  expect(r.text).toContain('pausing')
  // draining: new work is refused with the pause wording, running work may finish
  const d: any = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(d.deny).toContain('/eta pause')
  expect(seen.submits).toEqual([])
  await endTurn($, 't1')
  expect(seen.submits).toHaveLength(1)
  expect(seen.submits[0]).toContain(MARKER)
  expect(seen.submits[0]).toContain('pausing this session')
  expect(seen.submits[0]).not.toContain('5h usage limit')
  await startTurn($, 't2', seen.submits[0])
  await endTurn($, 't2')
  await clock.advance(2500)
  const saved = rec(store) as any
  expect(saved.manual).toBe(true)
  expect(saved.cleared).toBe(false)
  expect(seen.commands).toEqual([]) // no /clear for a manual pause
  expect(store['guard:trip']).toBeUndefined() // other sessions are not tripped
  expect(((await $.tool.call({ tool: 'Read', file_path: '/work/proj/a.ts' })) as any).deny).toBeUndefined() // reads are fine
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toContain('/eta resume')
  // hours pass and the limit resets (a fresh low reading): still paused
  await clock.advance(400 * MIN)
  await measure($, 3, 290)
  expect(seen.submits).toHaveLength(1)
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeDefined()
  expect(((await $.command.run({ command: 'eta', args: 'pause' })) as any).text).toContain('already paused')
  // back: resume with the pause wording
  const back: any = await $.command.run({ command: 'eta', args: 'resume' })
  expect(back.text).toContain('resuming')
  await clock.advance(1000)
  expect(seen.submits).toHaveLength(2)
  expect(seen.submits[1]).toContain(RESUME_MARKER)
  expect(seen.submits[1]).toContain('paused this session and is back')
  expect(rec(store)).toBeUndefined()
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined()
})

test('/eta pause turns a limit pause into one that waits for /eta resume', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen } = await pause($, on)
  const r: any = await $.command.run({ command: 'eta', args: 'pause' })
  expect(r.text).toContain('until you run /eta resume')
  expect((rec(store) as any).manual).toBe(true)
  await clock.advance(200 * MIN)
  expect(seen.submits).toHaveLength(1) // the reset passed and nothing resumed
  await $.command.run({ command: 'eta', args: 'resume' })
  await clock.advance(1000)
  expect(seen.submits).toHaveLength(2)
  expect(seen.submits[1]).toContain('paused this session and is back')
})

test('a manual pause survives a restart and an override hold', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen } = await boot($, on)
  store['guard:hold'] = { until: T0 + 5 * 60 * MIN, at: T0 }
  store['resume:/work/proj/.claude/aar/x/AAR.md'] = { aar: '/work/proj/.claude/aar/x/AAR.md', cwd: '/work/proj', resumeAt: Number.MAX_SAFE_INTEGER, cleared: false, oldSession: 'gone', manual: true }
  await $.session.start({ cwd: '/work/proj', surface: 'desktop', isInteractive: true })
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toContain('/eta resume')
  await clock.advance(400 * MIN)
  await measure($, 3, 290)
  expect(seen.submits).toEqual([])
  await $.command.run({ command: 'eta', args: 'resume' })
  await clock.advance(1000)
  expect(seen.submits).toHaveLength(1)
  expect(seen.submits[0]).toContain('/work/proj/.claude/aar/x/AAR.md')
  expect(store['guard:hold']).toBeDefined() // resuming a pause does not drop the override hold
})

test('shell checks: a newline, git branch -D and git diff --output are not read-only', () => {
  const dir = '/work/proj/.claude/aar'
  const ok = (command: string, tool = 'Bash') => toolAllowed('draining', tool, { command }, dir)
  expect(ok('git status')).toBe(true)
  expect(ok('git branch -a')).toBe(true)
  expect(ok('git status\nnpm run deploy')).toBe(false)
  expect(ok('git status\r\nrm -rf src')).toBe(false)
  expect(ok('Get-Location\nRemove-Item -Recurse src', 'PowerShell')).toBe(false)
  expect(ok('git branch -D master')).toBe(false)
  expect(ok('git branch new-name')).toBe(false)
  expect(ok('git diff --output=src/a.ts')).toBe(false)
})

test('thresholds never fall below the release line, whatever the thread count', () => {
  for (const [threads, cost] of [[7, 4.75], [16, 3], [40, 8]] as const) {
    const th = thresholds(threads, cost, 2)
    expect(th.used).toBeGreaterThanOrEqual(MIN_TRIP_USED)
    expect(th.used).toBeGreaterThan(RELEASE_BELOW_PCT)
    expect(th.est).toBeGreaterThan(th.used)
  }
})

test('a pause is adopted by its own session, or when no other live session is in its cycle', () => {
  const now = 1_000_000
  const rec = { aar: '/p/.claude/aar/1/AAR.md', oldSession: 'a' }
  expect(mayAdopt(rec, 'a', [{ id: 'a', t: now, cycle: rec.aar }], now)).toBe(true)
  // the owner was cleared into a new id: its heartbeat carries the cycle, so a second session must not take it
  expect(mayAdopt(rec, 'b', [{ id: 'a2', t: now - 1000, cycle: rec.aar }], now)).toBe(false)
  expect(mayAdopt(rec, 'b', [{ id: 'a2', t: now - 10 * MIN, cycle: rec.aar }], now)).toBe(true)
  expect(mayAdopt(rec, 'b', [{ id: 'c', t: now, cycle: '/other/AAR.md' }], now)).toBe(true)
  expect(mayAdopt(rec, 'b', [], now)).toBe(true)
})

test('a writing phase whose AAR turn never ends with the marker is released, not stuck', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, seen } = await boot($, on, false)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1') // the AAR is requested, but no AAR turn or file ever follows
  expect(seen.submits).toHaveLength(1)
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toContain('Usage guard')
  await clock.advance(11 * MIN)
  expect(seen.toasts.some(t => t.includes('AAR was not written'))).toBe(true)
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined()
})

test('a fresh window releasing the guard hands the held prompts back', { timeoutMs: 60_000 }, async ($, on) => {
  const { store, seen } = await boot($, on, false)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await $.prompt.submit({ text: 'please-do-the-thing', origin: { kind: 'composer' }, wait: false } as any)
  expect(cmdsOf(store)).toBeDefined()
  await measure($, 10, 290)
  expect(seen.toasts.some(t => t.includes('Limit guard released') && t.includes('please-do-the-thing'))).toBe(true)
  expect(cmdsOf(store)).toBeUndefined()
})

test('/eta bypass never takes the AAR turn that happens to contain its words', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, seen } = await boot($, on, false)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')
  expect(seen.submits[0]).toContain(MARKER)
  await $.command.run({ command: 'eta', args: 'bypass AAR' })
  await startTurn($, 't2', seen.submits[0]) // the AAR turn, which contains "AAR"
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toContain('Usage guard')
  await clock.advance(500)
})

test('shell checks: quoted or abbreviated options and git -c do not get through', () => {
  const dir = '/work/proj/.claude/aar'
  const ok = (command: string, tool = 'Bash') => toolAllowed('draining', tool, { command }, dir)
  expect(ok('git diff --out"put"=src/a.ts')).toBe(false)
  expect(ok('git diff --outpu\\t=src/a.ts')).toBe(false)
  expect(ok('git diff --out=src/a.ts')).toBe(false)
  expect(ok('git -c core.fsmonitor=touch status', 'PowerShell')).toBe(false)
  expect(ok('Get-Content (Remove-Item src)', 'PowerShell')).toBe(false)
  expect(ok('git log --oneline')).toBe(true)
  expect(ok('git -C "/work/proj" status')).toBe(true)
})

test('a second session in the folder does not take a pause owned by a cleared live session', { timeoutMs: 60_000 }, async ($, on) => {
  const { store } = await boot($, on, false)
  const aar = '/work/proj/.claude/aar/x/AAR.md'
  store[`resume:${aar}`] = { aar, cwd: '/work/proj', resumeAt: T0 + 300 * MIN, cleared: true, oldSession: 'gone-id' }
  // the owner was /cleared into another id, and is alive in the same cycle
  store['live:other-session'] = { t: T0, threads: 1, cwd: '/work/proj', cycle: aar }
  await $.session.start({ cwd: '/work/proj', surface: 'desktop', isInteractive: true })
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined() // not paused
  await $.command.run({ command: 'eta', args: 'resume' })
  expect(rec(store)).toBeDefined() // and /eta resume did not take or delete it either
})

test('a failed AAR submit hands the prompts back and does not leave them for the next AAR', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen, state } = await boot($, on, false)
  state.failSubmit = true
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await $.prompt.submit({ text: 'keep-this-prompt', origin: { kind: 'composer' }, wait: false } as any)
  await endTurn($, 't1')
  await clock.advance(1000)
  expect(seen.toasts.some(t => t.includes('could not be sent') && t.includes('keep-this-prompt'))).toBe(true)
  expect(cmdsOf(store)).toBeUndefined()
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined()
})

test('M1: a prompt typed as the guard is overridden is passed on, not dropped as "saved"', { timeoutMs: 60_000 }, async ($, on) => {
  const { store, seen } = await boot($, on, false)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  const [, r]: any[] = await Promise.all([
    $.command.run({ command: 'eta', args: 'override' }),
    $.prompt.submit({ text: 'typed-during-override', origin: { kind: 'composer' }, wait: false } as any),
  ])
  expect(r?.drop).toBeUndefined()
  expect(cmdsOf(store)).toBeUndefined()
})

test('M2: /eta resume mid-drain ignores another dead session\'s pause', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen } = await boot($, on, false)
  const aar = '/work/proj/.claude/aar/old-1/AAR.md'
  store[`resume:${aar}`] = { aar, cwd: '/work/proj', resumeAt: T0 + 300 * MIN, cleared: true, oldSession: 'dead' }
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  const r: any = await $.command.run({ command: 'eta', args: 'resume' })
  await clock.advance(1000)
  expect(String(r?.text)).toContain('no AAR was written yet')
  expect(seen.submits.some(x => x.includes(aar))).toBe(false)
  expect(store[`resume:${aar}`]).toBeDefined() // not touched either
})

test('M3: a session never adopts a pause another live session is in, even with its own old id', () => {
  const now = 5_000_000
  const rec = { aar: '/p/.claude/aar/1/AAR.md', oldSession: 'a' }
  expect(mayAdopt(rec, 'a', [{ id: 'b', t: now, cycle: rec.aar }], now)).toBe(false)
})

test('M4: a pause saved by 0.1.5 under the folder key is adopted once and then removed', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen } = await boot($, on, false)
  const aar = '/work/proj/.claude/aar/legacy-1/AAR.md'
  store['resume:/work/proj'] = { aar, cwd: '/work/proj', resumeAt: T0 + 300 * MIN, cleared: true, oldSession: 'gone' }
  await $.session.start({ cwd: '/work/proj', surface: 'desktop', isInteractive: true })
  expect(store['resume:/work/proj']).toBeUndefined()
  expect(store[`resume:${aar}`]).toBeDefined()
  await $.command.run({ command: 'eta', args: 'resume' })
  await clock.advance(1000)
  expect(Object.keys(store).filter(k => k.startsWith('resume:'))).toEqual([])
  expect(seen.submits.at(-1)).toContain(aar)
})

test('M5: AAR paths differ for two sessions tripping in the same second', () => {
  expect(aarPath('/p', T0, 'aaaa1111')).not.toBe(aarPath('/p', T0, 'bbbb2222'))
  expect(aarPath('/p', T0, 'aaaa1111')).toContain('/.claude/aar/')
})

test('M6: held prompts left by a crashed cycle are handed back at the next start', { timeoutMs: 60_000 }, async ($, on) => {
  const { store, seen } = await boot($, on, false)
  const aar = '/work/proj/.claude/aar/crashed-1/AAR.md'
  store[`guard:cmds:${aar}`] = [{ t: T0, text: 'left-behind-prompt', kind: 'held' }]
  await $.session.start({ cwd: '/work/proj', surface: 'desktop', isInteractive: true })
  expect(seen.toasts.some(x => x.includes('left-behind-prompt'))).toBe(true)
  expect(store[`guard:cmds:${aar}`]).toBeUndefined()
})

test('M7: a bypass queued behind the AAR turn does not expire while the guard is writing', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, seen } = await boot($, on, false)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')
  await $.command.run({ command: 'eta', args: 'bypass zzz-bypassed' })
  await clock.advance(3 * MIN) // longer than the 2-minute expiry, still in the writing phase
  expect(seen.toasts.some(x => x.includes('had not started'))).toBe(false)
  await startTurn($, 't2', 'zzz-bypassed')
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined()
})

test('M8: one hung engine call does not freeze the guard commands for good', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, state } = await boot($, on, false)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  state.hang = true // every file check now hangs
  const stuck = endTurn($, 't1').catch(() => undefined)
  let done = false
  const p = $.command.run({ command: 'eta', args: 'override' }).then(() => (done = true))
  await clock.advance(31_000)
  await Promise.race([p, new Promise(r => setTimeout(r, 200))])
  expect(done).toBe(true)
  void stuck
})

test('M9: brace expansion and smart quotes do not get past the read-only checks', () => {
  const dir = '/work/proj/.claude/aar'
  const ok = (command: string, tool = 'Bash') => toolAllowed('draining', tool, { command }, dir)
  expect(ok('git diff --o{u,u}tput=/tmp/x')).toBe(false)
  expect(ok("git diff --o\u2018\u2019utput=/tmp/x", 'PowerShell')).toBe(false)
  expect(ok('git status')).toBe(true)
})

/** An agent's own turn, as its loop reports it (any depth: the id is all the hook gets). */
const agentTurn = ($: any, agentId: string, turnId: string) => $.turn.start({ text: 'sub task', turnId, agentId })
const agentDone = async ($: any, agentId: string, turnId: string) => {
  await $.turn.complete({ turnId, agentId, reason: 'answer', answer: '', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
}

test('depth: agents the list never names are tracked by their own events and the AAR waits for them', async ($, on) => {
  const { clock, seen, agents } = await boot($, on)
  expect(agents).toEqual([]) // an empty list: a workflow agent or a fork
  await startTurn($, 't1', 'keep working')
  await agentTurn($, 'deep-agent-9', 'tx9')
  await measure($, 96, 180)
  await endTurn($, 't1')
  await clock.advance(31_000)
  expect(seen.submits).toEqual([]) // it still runs

  await agentDone($, 'deep-agent-9', 'tx9')
  await clock.advance(31_000)
  expect(seen.submits).toHaveLength(1)
  expect(seen.submits[0]).toContain(MARKER)
})

test('depth: a parent that only waits on its child, with the child unlisted, still holds the AAR', async ($, on) => {
  const { clock, seen, agents } = await boot($, on)
  agents.push({ id: 'parent-wait-1', type: 'general-purpose', status: 'waiting', description: 'orchestrates' })
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')
  await clock.advance(31_000)
  expect(seen.submits).toEqual([]) // `waiting` is not `running`, but it is not done

  agents.length = 0
  await clock.advance(31_000)
  expect(seen.submits).toHaveLength(1)
})

test('depth: past the drain limit every agent turn is aborted, deepest first, the main loop last', async ($, on) => {
  const { clock, seen, agents } = await boot($, on)
  agents.push(
    { id: 'lvl-1', type: 'general-purpose', status: 'waiting', description: 'a' },
    { id: 'lvl-2', parentId: 'lvl-1', type: 'general-purpose', status: 'waiting', description: 'b' },
    { id: 'lvl-3', parentId: 'lvl-2', type: 'general-purpose', status: 'running', description: 'c' },
  )
  await startTurn($, 't1', 'keep working')
  await agentTurn($, 'lvl-1', 'tl1')
  await agentTurn($, 'lvl-2', 'tl2')
  await agentTurn($, 'lvl-3', 'tl3')
  await measure($, 96, 180)
  await clock.advance(DRAIN_MAX_MS - 60_000)
  expect(seen.abort).toEqual([])
  await clock.advance(2 * 60_000)
  const agentsOnly = () => seen.abort.filter(id => id !== 't1')
  expect(agentsOnly()).toEqual(['tl3', 'tl2', 'tl1'])
  expect(seen.abort[seen.abort.length - 1]).toBe('t1') // the main loop is last
  // each agent is aborted once, not on every later tick
  await clock.advance(60_000)
  expect(agentsOnly()).toEqual(['tl3', 'tl2', 'tl1'])
})

test('depth: while the guard is active no agent starts, at any depth, and one started before is tracked', async ($, on) => {
  const { seen, spawned } = await boot($, on)
  const before: any = await $.agent.spawn({ prompt: 'before the guard' })
  expect(before.agentId).toBe('spawned-1')
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  const after: any = await $.agent.spawn({ prompt: 'during the guard' })
  expect(after.deny).toContain('Usage guard')
  expect(spawned.n).toBe(1) // the engine was never asked
  expect(seen.abort).toEqual([])
})

test('depth: an agent that keeps calling tools after the checkpoint request is aborted, once', async ($, on) => {
  const { clock, seen, agents } = await boot($, on)
  agents.push({ id: 'loud-agent-1', parentId: 'lvl-1', type: 'general-purpose', status: 'running', description: 'x' })
  await startTurn($, 't1', 'keep working')
  await agentTurn($, 'loud-agent-1', 'tloud')
  await measure($, 96, 180)
  for (let i = 0; i < 5; i++) await $.tool.call({ tool: 'Bash', command: 'make build', agentId: 'loud-agent-1' })
  await clock.advance(10)
  expect(seen.abort).toEqual([])
  for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Bash', command: 'make build', agentId: 'loud-agent-1' })
  await clock.advance(10)
  expect(seen.abort).toEqual(['tloud'])
})

test('review 3 / Major 1: a step that outlived the lock cannot undo a later /eta override', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, state, store } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1') // draining -> writing: the AAR request goes out
  await startTurn($, 't2', 'AAR ' + MARKER)
  state.hang = true // finishAar now hangs on the file check
  void endTurn($, 't2').catch(() => undefined)
  await clock.advance(31_000) // past the lock timeout: the queue moves on, the step is fenced off
  const r: any = await $.command.run({ command: 'eta', args: 'override' })
  expect(r.text).toContain('released')
  state.hang = false
  state.unhang.forEach(f => f()) // the hung check answers late: the AAR exists
  await clock.advance(1000)
  // the late step must not have paused the session again
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined()
  expect(rec(store)).toBeUndefined()
})

test('review 3 / Major 2: a bypassed prompt that never starts does not hold the drain forever', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await $.command.run({ command: 'eta', args: 'bypass do the thing' })
  await clock.advance(1000)
  await endTurn($, 't1') // the bypassed turn never starts (cancelled or rewritten)
  expect(seen.submits.filter(t => t.includes(MARKER))).toHaveLength(0)
  await clock.advance(3 * MIN)
  expect(seen.submits.filter(t => t.includes(MARKER))).toHaveLength(1)
})

test('review 3 / Major 4: a git repository planted in the AAR folder cannot be used to run a command', () => {
  const dir = '/work/proj/.claude/aar/x'
  const ok = (command: string) => toolAllowed('draining', 'Bash', { command }, dir)
  expect(ok(`git -C ${dir}/r status`)).toBe(false) // a repo the model wrote could name a hook in its config
  expect(ok(`git -C ${dir} status`)).toBe(false)
  expect(ok('git -C /work/proj status')).toBe(true)
  expect(ok('git diff --no-index a b')).toBe(false)
  expect(ok('git diff --ext-diff')).toBe(false)
  expect(ok('git show --textconv HEAD:f')).toBe(false)
  expect(ok('git status')).toBe(true)
  const w = (file_path: string) => toolAllowed('draining', 'Write', { file_path }, dir)
  expect(w(`${dir}/AAR.md`)).toBe(true)
  expect(w(`${dir}/r/.git/config`)).toBe(false)
  expect(w(`${dir}/r/.GIT/HEAD`)).toBe(false)
  expect(w(`${dir}/notes.gitignore.md`)).toBe(true)
})

test('review 3 / Major 5: a pause the person made is not an orphan to a session that starts a moment later', { timeoutMs: 60_000 }, async ($, on) => {
  const { store } = await boot($, on)
  await $.command.run({ command: 'eta', args: 'pause' })
  const beat = store['live:old-session-id'] as any
  expect(beat?.cycle).toContain('/.claude/aar/') // the heartbeat names the cycle right away
})

test('review 3 / Major 3: the adopted pause records its claimant, and the AAR path carries the session tag', { timeoutMs: 60_000 }, async ($, on) => {
  const { store, seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 180)
  await endTurn($, 't1')
  const aar = /(\/work\/proj\/\.claude\/aar\/[^ ]+\/AAR\.md)/.exec(seen.submits[0] ?? '')![1]
  expect(aar).toContain('oldsessi') // review 3 / M5: the call site adds the session tag, not only aarPath
  await startTurn($, 't2', seen.submits[0] ?? '')
  await endTurn($, 't2')
  expect((rec(store) as any).claimedBy).toBe('old-session-id')
})

test('review 3 / Major 3: another session claiming the pause makes this one step down, not resume twice', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 10)
  await endTurn($, 't1')
  await startTurn($, 't2', seen.submits[0] ?? '')
  await endTurn($, 't2')
  const key = Object.keys(store).find(k => k.startsWith('resume:'))!
  store[key] = { ...(store[key] as any), claimedBy: 'some-other-session' } // it woke from sleep and adopted it
  await clock.advance(20 * MIN)
  expect(seen.submits.filter(t => t.includes(RESUME_MARKER))).toHaveLength(0)
  expect(((await $.tool.call({ tool: 'Bash', command: 'npm test' })) as any).deny).toBeUndefined() // back to idle
})

test('autocomplete: /eta offers its subcommands, and only as the first word', () => {
  const rows = (text: string) => {
    const start = text.lastIndexOf(' ') + 1
    return etaCompletions(text, start, text.slice(start)).map(r => r.label ?? r.text.trim())
  }
  expect(rows('/eta ')).toEqual(['pause', 'resume', 'bypass <prompt>', 'override', 'guard on'])
  expect(rows('/eta re')).toEqual(['resume'])
  expect(rows('/eta by')).toEqual(['bypass <prompt>'])
  expect(rows('/eta ov')).toEqual(['override'])
  expect(rows('/eta override ')).toEqual(['off'])
  expect(rows('/eta guard ')).toEqual(['on'])
  expect(rows('/eta bypass fix the ')).toEqual([]) // the prompt is free text
  expect(rows('/other re')).toEqual([])
  expect(rows('please /eta re')).toEqual([])
  expect(etaCompletions('/eta bypass ', 5, 'bypass')[0]?.text).toBe('bypass ') // taking it leaves room for the prompt
})

test('review 4 / Major 2: an owner that wakes after the adopter resumed and deleted the record does not resume again', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 10)
  await endTurn($, 't1')
  await startTurn($, 't2', seen.submits[0] ?? '')
  await endTurn($, 't2')
  const key = Object.keys(store).find(k => k.startsWith('resume:'))!
  delete store[key] // the adopter resumed and removed the saved pause
  await clock.advance(20 * MIN)
  expect(seen.submits.filter(t => t.includes(RESUME_MARKER))).toHaveLength(0)
})

test('review 4 / Major 4: one failed agent list does not make the guard forget running agents', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, seen, agents, listFails } = await boot($, on)
  agents.push({ id: 'listed-agent-1', type: 'general-purpose', status: 'running', description: 'x' })
  await startTurn($, 't1', 'keep working')
  await agentTurn($, 'listed-agent-1', 'tla')
  await measure($, 96, 180)
  await endTurn($, 't1')
  listFails.on = true
  await clock.advance(31_000)
  expect(seen.submits).toEqual([]) // still waiting for it
  listFails.on = false
  agents.length = 0 // now it has really ended
  await clock.advance(31_000)
  expect(seen.submits).toHaveLength(1)
})

test('review 5: a store error at the resume check is retried, not taken for another session claiming the pause', { timeoutMs: 60_000 }, async ($, on) => {
  const { clock, store, seen, state } = await boot($, on)
  await startTurn($, 't1', 'keep working')
  await measure($, 96, 10)
  await endTurn($, 't1')
  await startTurn($, 't2', seen.submits[0] ?? '')
  await endTurn($, 't2')
  const key = Object.keys(store).find(k => k.startsWith('resume:'))!
  state.failKey = key
  await clock.advance(11 * MIN) // past the reset: the check runs and the read fails
  expect(seen.submits.filter(t => t.includes(RESUME_MARKER))).toHaveLength(0)
  state.failKey = ''
  await clock.advance(MIN)
  expect(seen.submits.filter(t => t.includes(RESUME_MARKER))).toHaveLength(1) // retried and resumed
})

test('rename: an AAR written under the old name keeps one commands block after a flush', () => {
  const oldBlock = '<!-- usage-eta:commands -->\nold\n<!-- /usage-eta:commands -->\n\n# AAR\nbody\n'
  const out = withCommands(oldBlock, [{ t: T0, text: 'do the thing', kind: 'held' } as any])
  expect(out.startsWith(CMD_BEGIN)).toBe(true)
  expect(out).not.toContain('usage-eta')
  expect(out).toContain('# AAR\nbody')
  expect(withCommands(out, [{ t: T0, text: 'again', kind: 'held' } as any]).split(CMD_BEGIN).length).toBe(2)
})
