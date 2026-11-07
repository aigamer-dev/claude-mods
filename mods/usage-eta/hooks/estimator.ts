import type { EgmRun, Task, Usage } from '../types'

export type EgmProfile = {
  runs: number
  runMin: number
  /** Agent types the last finished run spawned, in order. */
  plan: string[]
  agentMin: Record<string, number>
}

export type Model = {
  /** Tasks that carried an LLM ETA. */
  n: number
  /** EWMA of ln(actual / llmEta): the learned correction. */
  logRatio: number
  /** EWMA of |estimate - actual| / actual. */
  mape: number
  nAll: number
  avgTaskMin: number
  /** Effective tokens per minute of working time. */
  tokPerMin: number
  /** Five-hour limit percent per million effective tokens. */
  pctPerMtok: number
  nRate: number
  egm: Record<string, EgmProfile>
}

export const DEFAULT_PLANS: Record<string, string[]> = {
  'egm-review': [
    'egm:egm-zoom-out',
    'egm:egm-comprehension',
    'egm:egm-design',
    'egm:egm-zoom-out',
    'egm:egm-implementation-readiness',
  ],
}

export const blank = (): Model => ({
  n: 0,
  logRatio: 0,
  mape: 0.5,
  nAll: 0,
  avgTaskMin: 5,
  tokPerMin: 20000,
  pctPerMtok: 6,
  nRate: 0,
  egm: {},
})

const ewma = (old: number, x: number, n: number) => {
  const a = Math.max(0.2, 1 / (n + 1))
  return old + a * (x - old)
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** Multiplier applied to an LLM ETA; shrinks toward 1 until samples arrive. */
export const correction = (m: Model) =>
  clamp(Math.exp(m.logRatio * (m.n / (m.n + 2))), 0.25, 4)

export function learnTask(
  m: Model,
  s: { eta?: number; actualMin: number; tokens: number },
): Model {
  const actual = Math.max(0.05, s.actualMin)
  const out: Model = { ...m, nAll: m.nAll + 1 }
  out.avgTaskMin = ewma(m.avgTaskMin, actual, m.nAll)
  if (s.tokens > 0) {
    out.tokPerMin = ewma(m.tokPerMin, clamp(s.tokens / actual, 500, 400000), m.nAll)
  }
  if (s.eta && s.eta > 0) {
    const predicted = s.eta * correction(m)
    out.mape = ewma(m.mape, Math.abs(predicted - actual) / actual, m.n)
    out.logRatio = ewma(m.logRatio, Math.log(actual / s.eta), m.n)
    out.n = m.n + 1
  }
  return out
}

export function learnRate(m: Model, deltaPct: number, tokens: number): Model {
  // Other sessions on the account also spend the limit, so a tiny token count
  // against a whole percent is noise: wait for a real sample.
  if (deltaPct <= 0 || tokens < 20000) return m
  const x = clamp(deltaPct / (tokens / 1e6), 0.3, 60)
  return { ...m, pctPerMtok: ewma(m.pctPerMtok, x, m.nRate), nRate: m.nRate + 1 }
}

export function learnEgm(m: Model, run: EgmRun, now: number): Model {
  const prev = m.egm[run.skill]
  const runMin = ((run.doneAt ?? now) - run.startedAt) / 60000
  const agentMin = { ...(prev?.agentMin ?? {}) }
  for (const s of run.steps) {
    if (!s.doneAt) continue
    const min = (s.doneAt - s.startedAt) / 60000
    agentMin[s.type] = agentMin[s.type] === undefined ? min : ewma(agentMin[s.type], min, 3)
  }
  const profile: EgmProfile = {
    runs: (prev?.runs ?? 0) + 1,
    runMin: prev ? ewma(prev.runMin, runMin, prev.runs) : runMin,
    plan: run.steps.length > 0 ? run.steps.map(s => s.type) : (prev?.plan ?? []),
    agentMin,
  }
  return { ...m, egm: { ...m.egm, [run.skill]: profile } }
}

const UNIT: Record<string, number> = { s: 1 / 60, sec: 1 / 60, m: 1, min: 1, mins: 1, h: 60, hr: 60, hrs: 60 }

/** Splits "Write tests (~12m)" into the text and its minutes. */
export function splitEta(content: string): { text: string; eta?: number } {
  const re = /\s*[(\[]?\s*~\s*(\d+(?:\.\d+)?)\s*(hrs|hr|h|mins|min|m|sec|s)?\s*[)\]]?\s*$/i
  const hit = re.exec(content)
  if (!hit) return { text: content.trim() }
  const unit = UNIT[(hit[2] ?? 'm').toLowerCase()] ?? 1
  return { text: content.slice(0, hit.index).trim(), eta: Number(hit[1]) * unit }
}

export type Todo = { content: string; status: Task['status']; key?: string }

export function syncTodos(
  prev: readonly Task[],
  todos: readonly Todo[],
  now: number,
  tok: number,
  base: { t: number; tok: number },
): { tasks: Task[]; done: Task[] } {
  const done: Task[] = []
  const tasks = todos.map((t): Task => {
    const { text, eta } = splitEta(t.content)
    const old = prev.find(p => p.text === text)
    const task: Task = {
      id: text,
      text,
      eta: eta ?? old?.eta,
      status: t.status,
      startedAt: old?.startedAt,
      doneAt: old?.doneAt,
      tokStart: old?.tokStart,
    }
    if (t.status === 'in_progress' && task.startedAt === undefined) {
      task.startedAt = now
      task.tokStart = tok
    }
    if (t.status === 'completed' && old && old.status !== 'completed') {
      task.doneAt = now
      if (task.startedAt === undefined) {
        task.startedAt = base.t
        task.tokStart = base.tok
      }
      done.push(task)
    }
    return task
  })
  return { tasks, done }
}

export const estTaskMin = (t: Task, m: Model) =>
  t.eta ? t.eta * correction(m) : m.avgTaskMin

export type Forecast = {
  remainingMin: number
  lowMin: number
  highMin: number
  tokens: number
  pctNeeded: number
  headroomTokens?: number
  minsToReset?: number
  fits: boolean
  reason: string
  pending: number
  isLearning: boolean
}

export function expectedAgents(run: EgmRun | null, m: Model): string[] {
  if (!run || run.doneAt) return []
  const plan = m.egm[run.skill]?.plan ?? DEFAULT_PLANS[run.skill] ?? []
  const left = [...plan]
  for (const s of run.steps) {
    const i = left.indexOf(s.type)
    if (i >= 0) left.splice(i, 1)
  }
  return left
}

export function forecast(
  tasks: readonly Task[],
  egm: EgmRun | null,
  usage: Usage,
  m: Model,
  now: number,
): Forecast {
  let rem = 0
  let pending = 0
  for (const t of tasks) {
    if (t.status === 'completed') continue
    pending += 1
    const est = estTaskMin(t, m)
    if (t.status === 'in_progress' && t.startedAt !== undefined) {
      const elapsed = (now - t.startedAt) / 60000
      rem += Math.max(est * 0.15, est - elapsed)
    } else {
      rem += est
    }
  }
  if (egm && !egm.doneAt) {
    const running = egm.steps.filter(s => !s.doneAt)
    for (const s of running) {
      const avg = m.egm[egm.skill]?.agentMin[s.type] ?? 3
      rem += Math.max(avg * 0.15, avg - (now - s.startedAt) / 60000)
    }
    for (const type of expectedAgents(egm, m)) {
      rem += m.egm[egm.skill]?.agentMin[type] ?? 3
    }
  }
  const spread = clamp(m.mape, 0.15, 1)
  const tokens = rem * m.tokPerMin
  const pctNeeded = (tokens / 1e6) * m.pctPerMtok
  const five = usage.fiveHour
  const minsToReset = five?.resetsAt
    ? Math.max(0, (Date.parse(five.resetsAt) - now) / 60000)
    : undefined
  const used = five?.pct ?? 0
  const headroomTokens = five ? ((100 - used) / m.pctPerMtok) * 1e6 : undefined
  const fitsPct = used + pctNeeded <= 100
  const fitsTime = minsToReset === undefined || rem <= minsToReset
  let reason = 'fits in this 5h window'
  if (!fitsPct) {
    reason = `needs ~${pctNeeded.toFixed(0)}% but only ${(100 - used).toFixed(0)}% is left`
  } else if (!fitsTime) {
    reason = `runs ~${fmtMin(rem - (minsToReset ?? 0))} past the reset`
  } else if (!five) {
    reason = 'no limit reading yet (needs a subscription response)'
  }
  return {
    remainingMin: rem,
    lowMin: rem * (1 - spread),
    highMin: rem * (1 + spread),
    tokens,
    pctNeeded,
    headroomTokens,
    minsToReset,
    fits: fitsPct && fitsTime,
    reason,
    pending,
    isLearning: m.n < 5 || m.nRate < 3,
  }
}

export function fmtMin(min: number): string {
  if (!isFinite(min) || min < 0) return '0m'
  if (min < 1) return `${Math.round(min * 60)}s`
  if (min < 60) return `${Math.round(min)}m`
  const h = Math.floor(min / 60)
  const mm = Math.round(min - h * 60)
  if (h >= 48) return `${Math.round(h / 24)}d`
  return mm ? `${h}h${String(mm).padStart(2, '0')}m` : `${h}h`
}

export function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

export function bar(pct: number, width = 16): string {
  const f = Math.round((clamp(pct, 0, 100) / 100) * width)
  return '█'.repeat(f) + '░'.repeat(width - f)
}

export const TRACKED = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'mcp__ccd_turn__update_plan',
])

const STATUSES = new Set(['pending', 'in_progress', 'completed'])
const asStatus = (s: unknown): Task['status'] =>
  typeof s === 'string' && STATUSES.has(s) ? (s as Task['status']) : 'pending'

/**
 * Applies one task-tool call to a todo list. Handles the CLI's TodoWrite and
 * TaskCreate/TaskUpdate and the desktop app's update_plan; `text` is the tool's
 * result, which names a created task's id.
 */
export function applyTool(
  list: readonly Todo[],
  tool: string,
  input: Record<string, unknown>,
  text?: string,
): Todo[] {
  if (tool === 'TodoWrite') {
    const todos = (input.todos as { content?: string; status?: string }[] | undefined) ?? []
    return todos.map(t => ({ content: String(t.content ?? ''), status: asStatus(t.status) }))
  }
  if (tool === 'TaskCreate') {
    const id = /#(\d+)/.exec(text ?? '')?.[1] ?? String(list.length + 1)
    return [...list, { content: String(input.subject ?? ''), status: 'pending', key: id }]
  }
  if (tool === 'TaskUpdate') {
    const id = String(input.taskId ?? '')
    if (input.status === 'deleted') return list.filter(t => t.key !== id)
    return list.map(t =>
      t.key === id
        ? {
            ...t,
            content: typeof input.subject === 'string' ? input.subject : t.content,
            status: input.status === undefined ? t.status : asStatus(input.status),
          }
        : t,
    )
  }
  if (tool === 'mcp__ccd_turn__update_plan') {
    let out = list.map(t => ({ ...t }))
    const items = input.items as { content?: string; status?: string }[] | undefined
    if (items) out = items.map(t => ({ content: String(t.content ?? ''), status: asStatus(t.status) }))
    if (input.advance) {
      const i = out.findIndex(t => t.status === 'in_progress')
      if (i >= 0) out[i] = { ...out[i], status: 'completed' }
      const j = out.findIndex(t => t.status === 'pending')
      if (j >= 0) out[j] = { ...out[j], status: 'in_progress' }
    }
    for (const n of (input.done as number[] | undefined) ?? []) {
      if (out[n - 1]) out[n - 1] = { ...out[n - 1], status: 'completed' }
    }
    if (typeof input.start === 'number' && out[input.start - 1]) {
      out[input.start - 1] = { ...out[input.start - 1], status: 'in_progress' }
    }
    return out
  }
  return [...list]
}
