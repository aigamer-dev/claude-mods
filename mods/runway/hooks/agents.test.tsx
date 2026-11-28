import { expect, test } from 'claude-code/testing'

import {
  abortOrder,
  DENY_ABORT_AFTER,
  depthOf,
  live,
  maxDepth,
  merge,
  noteDenied,
  noteEnd,
  noteSeen,
  newCycle,
  noteSpawn,
  prune,
  STALE_MS,
  type Tree,
} from './agents'
import { chain } from './agents.test.helpers'

const T0 = 1_000_000

test('an agent twelve levels down is counted and reached', () => {
  const t = chain(12)
  expect(live(t, T0)).toHaveLength(12)
  expect(depthOf(t, 'a11')).toBe(11)
  expect(maxDepth(t, T0)).toBe(12)
})

test('aborts go deepest first, so no parent is cut off above a live child', () => {
  const t = chain(5)
  expect(abortOrder(t, T0)).toEqual(['turn4', 'turn3', 'turn2', 'turn1', 'turn0'])
})

test('an agent only its own events know (a workflow agent or a fork) is still counted', () => {
  const t: Tree = new Map()
  noteSeen(t, 'fork1', T0, 'tf')
  expect(live(t, T0).map(r => r.id)).toEqual(['fork1'])
})

test('a parent that waits on a child stays live through the list, not by events', () => {
  const t = chain(2)
  const later = T0 + STALE_MS + 1
  expect(live(t, later)).toHaveLength(0)
  merge(t, [{ id: 'a0', parentId: undefined, type: 'general-purpose', status: 'waiting' }], later)
  expect(live(t, later).map(r => r.id)).toEqual(['a0'])
})

test('an agent the list shows as ended is not live, even if its events were recent', () => {
  const t = chain(3)
  merge(t, [{ id: 'a2', parentId: 'a1', status: 'completed' }], T0 + 1000)
  expect(live(t, T0 + 1000).map(r => r.id)).toEqual(['a0', 'a1'])
})

test('a message that resumes an ended agent makes it live again', () => {
  const t = chain(1)
  noteEnd(t, 'a0', T0 + 1)
  expect(live(t, T0 + 2)).toHaveLength(0)
  noteSeen(t, 'a0', T0 + 3, 'turn-again')
  expect(live(t, T0 + 3)).toHaveLength(1)
})

test('an agent that goes quiet for longer than STALE_MS is taken to be gone', () => {
  const t = chain(1)
  expect(live(t, T0 + STALE_MS)).toHaveLength(1)
  expect(live(t, T0 + STALE_MS + 1)).toHaveLength(0)
})

test('a parent link that loops cannot hang depthOf', () => {
  const t: Tree = new Map()
  noteSpawn(t, 'x', 'y', undefined, T0)
  noteSpawn(t, 'y', 'x', undefined, T0)
  expect(depthOf(t, 'x')).toBeLessThan(5)
})

test('an agent that ignores the checkpoint request is aborted once, after DENY_ABORT_AFTER refusals', () => {
  const t = chain(3)
  const hits: boolean[] = []
  for (let i = 0; i < DENY_ABORT_AFTER + 2; i++) hits.push(noteDenied(t, 'a2', T0))
  expect(hits.filter(Boolean)).toHaveLength(1)
  expect(hits.indexOf(true)).toBe(DENY_ABORT_AFTER - 1)
})

test('a refused agent whose turn is unknown is not reported for abort', () => {
  const t: Tree = new Map()
  const hits: boolean[] = []
  for (let i = 0; i < DENY_ABORT_AFTER; i++) hits.push(noteDenied(t, 'ghost', T0))
  expect(hits.some(Boolean)).toBe(false)
})

test('prune drops ended and stale agents and keeps the live ones', () => {
  const t = chain(3)
  noteEnd(t, 'a2', T0 + 10)
  prune(t, T0 + 20)
  expect([...t.keys()].sort()).toEqual(['a0', 'a1'])
})

test('an agent the list named and then dropped has ended; one it never named stays on its events', () => {
  const t = chain(2) // never named by the list
  merge(t, [{ id: 'listed-1', status: 'running' }], T0)
  expect(live(t, T0).map(r => r.id).sort()).toEqual(['a0', 'a1', 'listed-1'])
  merge(t, [], T0 + 1000) // the list no longer has listed-1
  expect(live(t, T0 + 1000).map(r => r.id).sort()).toEqual(['a0', 'a1'])
})

test('a spawn answered after the agent finished does not bring it back to life', () => {
  const t: Tree = new Map()
  noteSeen(t, 'child', T0, 'tc')
  noteEnd(t, 'child', T0 + 5) // its turn.complete came first
  noteSpawn(t, 'child', 'parent', 'general-purpose', T0 + 6) // then agent.spawn's next() returned
  expect(live(t, T0 + 6)).toHaveLength(0)
  expect(t.get('child')?.parent).toBe('parent') // but the missing parent link is filled in
})

test('an agent whose turn is unknown at the 6th refusal is still aborted once the turn is known', () => {
  const t: Tree = new Map()
  for (let i = 0; i < DENY_ABORT_AFTER; i++) expect(noteDenied(t, 'x', T0)).toBe(false)
  noteSeen(t, 'x', T0, 'tx')
  expect(noteDenied(t, 'x', T0)).toBe(true)
  expect(noteDenied(t, 'x', T0)).toBe(false) // once per turn
})

test('a new guard cycle starts the refusal counts over', () => {
  const t = chain(1)
  for (let i = 0; i < DENY_ABORT_AFTER - 1; i++) noteDenied(t, 'a0', T0)
  newCycle(t, T0)
  expect(noteDenied(t, 'a0', T0)).toBe(false) // 1 of 6 now, not the 6th
})
