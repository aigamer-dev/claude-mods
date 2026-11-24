import { expect, mock, test } from 'claude-code/testing'

import { CMD_BEGIN, DRAIN_MAX_MS, MARKER, RESUME_MARKER } from './guard'

const T0 = 1_700_000_000_000
const MIN = 60_000

let CLK: any

/** Boots the mod on a mocked world and records what the guard does. */
async function boot($: any, on: any, aarExists = true, cwd = '/work/proj') {
  const clock = mock.clock(on, { now: T0 })
  const store: Record<string, unknown> = {}
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('store.delete', (_: any, e: any) => (delete store[e.key], { value: undefined }))
  const agents: any[] = []
  const seen = { abort: [] as string[], submits: [] as string[], commands: [] as string[], procs: [] as string[][], toasts: [] as string[] }
  on('agent.list', () => ({ value: agents }))
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('session.cwd', () => ({ value: cwd }))
  let sid = 'old-session-id'
  on('session.id', () => ({ value: sid }))
  on('session.messages', () => ({ value: [] }))
  const files: Record<string, string> = {}
  const state = { exists: aarExists }
  const listing: { name: string; kind: string }[] = []
  on('fs.list', () => ({ value: listing }))
  on('fs.exists', () => ({ value: state.exists }))
  on('fs.read', (_: any, e: any) => ({ value: files[e.path] ?? '# AAR\nNext steps: 1. build' }))
  on('fs.write', (_: any, e: any) => ((files[e.path] = e.text ?? e.content), { value: undefined }))
  on('turn.abort', (_: any, e: any) => (seen.abort.push(e.turnId), { value: undefined }))
  on('prompt.submit', (_: any, e: any) => (seen.submits.push(e.text), { text: e.text } as never))
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
  return { clock, store, seen, agents, files, state, listing }
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
  expect((store['resume:/work/proj'] as any).cleared).toBe(true)
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
  expect(store['resume:/work/proj']).toBeUndefined()
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
  expect(store['resume:/work/proj']).toBeUndefined()
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
  expect(store['resume:/work/proj']).toBeDefined()
  const r: any = await $.command.run({ command: 'eta', args: 'override' })
  expect(r.text).toContain('released')
  expect(store['resume:/work/proj']).toBeUndefined()
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
  const cmds = store['guard:cmds:/work/proj'] as any[]
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
  expect(store['guard:cmds:/work/proj']).toBeUndefined()
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
  expect(aar.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')).toBe((store['resume:/work/proj'] as any).aar)
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
  expect(none.text).toContain('usage is')
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
  expect(store['resume:/work/proj']).toBeDefined() // still paused for the reset
})

test('/eta override gives back the prompts that were held', async ($, on) => {
  const { store } = await pause($, on)
  await $.prompt.submit({ text: 'ship it', origin: { kind: 'composer' }, wait: false } as any)
  const r: any = await $.command.run({ command: 'eta', args: 'override' })
  expect(r.text).toContain('ship it')
  expect(store['guard:cmds:/work/proj']).toBeUndefined()
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
  expect(store['resume:/work/proj']).toBeUndefined()
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
  expect(store['guard:cmds:/work/proj']).toBeUndefined()
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
