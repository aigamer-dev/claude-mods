import { noteSeen, noteSpawn } from './agents'
import type { Tree } from './agents'

const T0 = 1_000_000

/** A chain main -> a0 -> a1 -> ... -> a(n-1), each spawned by the one before it. */
export function chain(n: number): Tree {
  const t: Tree = new Map()
  for (let i = 0; i < n; i++) {
    noteSpawn(t, `a${i}`, i === 0 ? undefined : `a${i - 1}`, 'general-purpose', T0)
    noteSeen(t, `a${i}`, T0, `turn${i}`)
  }
  return t
}

