/**
 * The agent tree: every agent of the session at any depth, built from the
 * events of each loop and `$.agent.list()` together.
 *
 * `$.agent.list()` alone is not enough: it leaves out a workflow's agents and
 * the engine's forks, drops an entry seconds after its agent ends, and a
 * parent that waits on its child is `waiting`, not `running`. So every hook
 * that carries an `agentId` records it here, whatever the depth, and the guard
 * counts, drains and stops the whole tree from this record.
 */

/** An agent with no event and no list entry for this long is taken to be gone. */
export const STALE_MS = 5 * 60_000
/** Denied tool calls from one agent after which its turn is aborted (it ignores the checkpoint request). */
export const DENY_ABORT_AFTER = 6
/** Parent links followed at most: a cycle in a bad record cannot loop. */
const MAX_DEPTH = 1000

export type AgentRec = {
  id: string
  parent?: string
  type?: string
  /** The turn the agent's loop runs now, for `$.turn.abort`. */
  turnId?: string
  /** Last time an event or a list entry showed it alive. */
  seen: number
  ended?: boolean
  /** True once `$.agent.list()` has named it: from then on, being left off the list means it ended. */
  listed?: boolean
  /** Tool calls refused to it while the guard was active. */
  denied: number
  /** True once its turn was reported for abort, so it is asked for once per turn. */
  aborted?: boolean
}

export type Tree = Map<string, AgentRec>

/** What of `$.agent.list()`'s entry the tree reads. */
export type Listed = { id: string; parentId?: string; type?: string; status: string }

const ACTIVE = new Set(['pending', 'running', 'waiting'])

/** The record of an agent, made on first sight: a workflow's agent or a fork is first seen by its events. */
function rec(t: Tree, id: string, now: number): AgentRec {
  let r = t.get(id)
  if (!r) {
    r = { id, seen: now, denied: 0 }
    t.set(id, r)
  }
  return r
}

/** An agent was spawned (`agent.spawn` answered its `agentId`) by the loop `parent` (absent: the main loop). */
export function noteSpawn(t: Tree, id: string, parent: string | undefined, type: string | undefined, now: number) {
  // `agent.spawn` may answer only once the agent has finished: its own events (turn.complete) are
  // then already in, and the spawn must not bring a finished agent back to life. It fills in what is missing.
  const known = t.has(id)
  const r = rec(t, id, now)
  r.parent = r.parent ?? parent
  r.type = r.type ?? type
  if (!known) r.ended = false
}

/** An event of the agent's loop (a tool call, a turn start or step): it is alive. */
export function noteSeen(t: Tree, id: string, now: number, turnId?: string) {
  const r = rec(t, id, now)
  r.seen = now
  if (turnId && turnId !== r.turnId) {
    r.turnId = turnId
    r.aborted = false
  }
  // A message may resume an ended agent under the same id.
  r.ended = false
}

/** The agent's turn completed: it is between turns or done. */
export function noteEnd(t: Tree, id: string, now: number) {
  const r = rec(t, id, now)
  r.seen = now
  r.ended = true
  r.turnId = undefined
}

/**
 * Adds what `$.agent.list()` shows; its word on status wins for the agents it names. The list drops an
 * entry once its agent has ended, so an agent it named before and no longer names is over. One it never
 * named (a workflow's agent, a fork) is known by its events alone.
 */
export function merge(t: Tree, list: readonly Listed[], now: number) {
  const named = new Set(list.map(a => a.id))
  for (const r of t.values()) {
    if (r.listed && !named.has(r.id)) {
      r.ended = true
      r.turnId = undefined
    }
  }
  for (const a of list) {
    const r = rec(t, a.id, now)
    r.listed = true
    r.parent = a.parentId ?? r.parent
    r.type = a.type ?? r.type
    if (ACTIVE.has(a.status)) {
      r.seen = now
      r.ended = false
    } else {
      r.ended = true
      r.turnId = undefined
    }
  }
}

/** Agents still working: not ended, and seen within STALE_MS. */
export function live(t: Tree, now: number): AgentRec[] {
  return [...t.values()].filter(r => !r.ended && now - r.seen <= STALE_MS)
}

/** Parent links from the agent up to the main loop (0 = a child of the main loop). */
export function depthOf(t: Tree, id: string): number {
  let d = 0
  const seen = new Set<string>([id])
  for (let p = t.get(id)?.parent; p && d < MAX_DEPTH; p = t.get(p)?.parent) {
    if (seen.has(p)) break
    seen.add(p)
    d++
  }
  return d
}

/** The deepest live chain: how far down the guard has to reach. */
export function maxDepth(t: Tree, now: number): number {
  return live(t, now).reduce((m, r) => Math.max(m, depthOf(t, r.id) + 1), 0)
}

/**
 * Turns to abort, deepest agent first, so a parent is never cut off while a
 * child of it still runs unseen. Only agents whose turn is known can be aborted.
 */
export function abortOrder(t: Tree, now: number): string[] {
  return live(t, now)
    .filter(r => r.turnId)
    .sort((a, b) => depthOf(t, b.id) - depthOf(t, a.id))
    .map(r => r.turnId as string)
}

/** Counts a refused tool call; true once the agent has ignored the checkpoint request long enough to abort it. */
export function noteDenied(t: Tree, id: string, now: number): boolean {
  const r = rec(t, id, now)
  r.denied++
  if (r.denied < DENY_ABORT_AFTER || !r.turnId || r.aborted) return false
  r.aborted = true
  return true
}

/** A new guard cycle: agents that are gone are forgotten and the refusal counts start again. */
export function newCycle(t: Tree, now: number) {
  prune(t, now)
  for (const r of t.values()) {
    r.denied = 0
    r.aborted = false
  }
}

/** Forgets every ended agent: a new guard cycle starts from the agents that are still there. */
export function prune(t: Tree, now: number) {
  for (const [id, r] of t) {
    if (r.ended || now - r.seen > STALE_MS) t.delete(id)
  }
}
