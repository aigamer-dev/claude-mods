/**
 * The pane and status line as plain data: lines of styled segments, laid out for the width the pane
 * has. Pure (no engine, no JSX), so every layout rule is unit tested; register.tsx only draws the lines.
 */
import { barParts, fmtMin, fmtTok } from './estimator'

export type Color = 'red' | 'yellow' | 'green' | 'cyan' | 'white'
export type Seg = { t: string; color?: Color; bold?: boolean; dim?: boolean }
export type Line = Seg[]

export type TaskRow = {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Minutes the estimator expects (or, once finished, expected). */
  estMin: number
  /** The model's own estimate, when it gave one. */
  eta?: number
  /** Minutes spent so far or in all. */
  spentMin?: number
}

export type AgentRow = { id: string; type: string; label?: string; depth: number; since: number }

export type ViewModel = {
  /** Cells across the pane body. */
  cols: number
  now: number
  five?: { pct: number; resetsAt?: string }
  week?: { pct: number; resetsAt?: string }
  /** Percent of the 5h limit the tasks left are expected to use (0 when none are left). */
  estPct: number
  guard?: { phase: 'draining' | 'writing' | 'waiting'; manual: boolean; resumeAt?: number; since?: number }
  /** Live agents, parents before their children. */
  agents: AgentRow[]
  tasks: TaskRow[]
  egm?: {
    skill: string
    doneMin?: number
    steps: { type: string; label?: string; done: boolean; min: number }[]
    left: { type: string; estMin: number }[]
  }
  /** Absent when there is nothing left to estimate. */
  forecast?: { remainingMin: number; lowMin: number; highMin: number; tokens: number; pctNeeded: number; fits: boolean; reason: string }
  session: { tokens: number; usd: number }
  model: { n: number; correction: number; mape: number; tokPerMin: number; pctPerMtok: number; learning: boolean; nAll: number; nTurn: number; nAgent: number; nRate: number }
}

/** Panes narrower than this drop the secondary detail. */
export const COMPACT_BELOW = 46
const MAX_AGENT_ROWS = 8
const MAX_AGENT_ROWS_COMPACT = 5
const MAX_DONE_TASKS = 3
const MAX_INDENT = 6

const seg = (t: string, o: Omit<Seg, 't'> = {}): Seg => ({ t, ...o })
const blank = (): Line => [seg(' ')]
const len = (l: Line) => l.reduce((n, s) => n + s.t.length, 0)

/** Cuts a line to `cols` cells, ending with an ellipsis where it was cut. */
export function clip(line: Line, cols: number): Line {
  if (len(line) <= cols) return line
  const out: Line = []
  let room = Math.max(1, cols - 1)
  for (const s of line) {
    if (room <= 0) break
    if (s.t.length <= room) {
      out.push(s)
      room -= s.t.length
    } else {
      out.push({ ...s, t: s.t.slice(0, room) })
      room = 0
    }
  }
  const last = out[out.length - 1]
  if (last) out.push({ ...last, t: '…' })
  return out
}

/** Colour of a limit by how full it is: green, then yellow, then red. */
export const levelColor = (pct: number): Color => (pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green')

const reset = (l: { resetsAt?: string } | undefined, now: number) =>
  l?.resetsAt && Date.parse(l.resetsAt) > now ? fmtMin((Date.parse(l.resetsAt) - now) / 60000) : undefined

const clock = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A section heading with a rule that fills the rest of the row. */
function heading(title: string, cols: number, extra = ''): Line {
  const head = `${title}${extra ? ` ${extra}` : ''}`
  return [seg(head, { bold: true, color: 'cyan' }), seg(` ${'─'.repeat(Math.max(0, cols - head.length - 1))}`, { dim: true })]
}

/** A bar of `width` cells: used (coloured by level), estimated for the tasks left (white), unused (dim). */
function meter(width: number, used: number, est: number): Line {
  const p = barParts(used, est, width)
  const over = used + est > 100
  return [
    seg('█'.repeat(p.used), { color: levelColor(over ? 100 : used) }),
    seg('█'.repeat(p.est), { color: 'white' }),
    seg('░'.repeat(p.free), { dim: true }),
  ]
}

type Limit = { pct: number; resetsAt?: string } | undefined

/** What follows a limit's bar: the percent, the estimate for the tasks left, the reset countdown. */
const limitTail = (l: Limit, est: number, now: number) => {
  const e = est > 0.5 ? ` +${est.toFixed(0)}%` : ''
  const r = reset(l, now)
  return { pct: l ? `${l.pct.toFixed(0)}%` : '--', e, r }
}

/** One bar width for both limits (the longer tail decides), so the bars line up. */
function barWidth(label: string, rows: { l: Limit; est: number }[], cols: number, now: number) {
  const tail = Math.max(...rows.map(x => { const t = limitTail(x.l, x.est, now); return 1 + t.pct.length + t.e.length + (t.r ? t.r.length + 2 : 0) }))
  return Math.max(6, Math.min(28, cols - label.length - tail))
}

function limitRow(label: string, l: Limit, est: number, cols: number, now: number, width: number): Line {
  const { pct, e, r } = limitTail(l, est, now)
  const line: Line = [seg(label), ...meter(width, l?.pct ?? 0, est)]
  line.push(seg(` ${pct}`, { bold: true, color: l ? levelColor(l.pct + est) : undefined }))
  if (e) line.push(seg(e, { color: 'white' }))
  if (r) line.push(seg(` ↻${r}`, { dim: true }))
  return clip(line, cols)
}

function guardLines(m: ViewModel): Line[] {
  const g = m.guard
  if (!g) return []
  if (g.phase === 'draining') {
    const s = g.since !== undefined ? ` (${fmtMin((m.now - g.since) / 60000)})` : ''
    return [
      [seg(`⧗ Guard: finishing running work${s}`, { bold: true, color: 'yellow' })],
      [seg('no new work or agents start; agents write their checkpoints', { dim: true })],
    ]
  }
  if (g.phase === 'writing') {
    return [[seg('✎ Guard: writing the AAR', { bold: true, color: 'yellow' })]]
  }
  if (g.manual) {
    return [
      [seg('‖ Paused by you', { bold: true, color: 'yellow' })],
      [seg('/eta resume continues from the AAR', { dim: true })],
    ]
  }
  const when = g.resumeAt !== undefined ? ` resumes in ${fmtMin(Math.max(0, g.resumeAt - m.now) / 60000)} (${clock(g.resumeAt)})` : ''
  return [
    [seg(`‖ Paused,${when}`, { bold: true, color: 'yellow' })],
    [seg('/eta resume goes now', { dim: true })],
  ]
}

function agentLines(m: ViewModel, compact: boolean): Line[] {
  if (m.agents.length === 0) return []
  const depth = m.agents.reduce((d, a) => Math.max(d, a.depth + 1), 0)
  const cap = compact ? MAX_AGENT_ROWS_COMPACT : MAX_AGENT_ROWS
  const out: Line[] = [blank(), heading('Agents', m.cols, `${m.agents.length} running · ${depth} deep`)]
  for (const a of m.agents.slice(0, cap)) {
    const indent = '  '.repeat(Math.min(a.depth, MAX_INDENT))
    const mark = a.depth > MAX_INDENT ? '⋯ ' : a.depth > 0 ? '└ ' : '• '
    const time = fmtMin((m.now - a.since) / 60000)
    const line: Line = [seg(indent + mark, { dim: true }), seg(a.type.replace('egm:', ''), { color: 'cyan' })]
    if (a.label && !compact) line.push(seg(` ${a.label}`, { dim: true }))
    line.push(seg(` · ${time}`, { dim: true }))
    out.push(clip(line, m.cols))
  }
  if (m.agents.length > cap) out.push([seg(`… +${m.agents.length - cap} more agents`, { dim: true })])
  return out
}

const taskBar = (done: number, total: number, width: number): Line => {
  const f = total === 0 ? 0 : Math.round((done / total) * width)
  return [seg('▰'.repeat(f), { color: 'green' }), seg('▱'.repeat(width - f), { dim: true })]
}

/** Over or under the estimate, as `+3m` (yellow) or `-2m` (green); nothing within a minute. */
function delta(spent: number, est: number): Seg | undefined {
  const d = spent - est
  if (!isFinite(d) || Math.abs(d) < 1) return undefined
  return d > 0 ? seg(` +${fmtMin(d)}`, { color: 'yellow' }) : seg(` -${fmtMin(-d)}`, { color: 'green' })
}

function taskLine(t: TaskRow, cols: number): Line {
  const icon = t.status === 'completed' ? seg('✔ ', { color: 'green' }) : t.status === 'in_progress' ? seg('▶ ', { color: 'cyan', bold: true }) : seg('○ ', { dim: true })
  const dim = t.status === 'completed'
  const spent = t.spentMin ?? 0
  const tail: Seg[] = []
  if (t.status === 'completed') {
    tail.push(seg(` · ${fmtMin(spent)}`, { dim: true }))
    const d = delta(spent, t.estMin)
    if (d) tail.push(d)
  } else if (t.status === 'in_progress') {
    tail.push(seg(` · ${fmtMin(spent)} of ~${fmtMin(t.estMin)}`, { dim: spent <= t.estMin, color: spent > t.estMin ? 'yellow' : undefined }))
  } else {
    tail.push(seg(` · est ${fmtMin(t.estMin)}`, { dim: true }))
  }
  if (t.eta && t.status !== 'completed') tail.push(seg(` (llm ${fmtMin(t.eta)})`, { dim: true }))
  const room = Math.max(8, cols - 2 - tail.reduce((n, s) => n + s.t.length, 0))
  const text = t.text.length > room ? `${t.text.slice(0, room - 1)}…` : t.text
  return clip([icon, seg(text, { dim, bold: t.status === 'in_progress' }), ...tail], cols)
}

function taskLines(m: ViewModel): Line[] {
  const done = m.tasks.filter(t => t.status === 'completed')
  const active = m.tasks.filter(t => t.status === 'in_progress')
  const pending = m.tasks.filter(t => t.status === 'pending')
  const barW = Math.max(6, Math.min(16, m.cols - 24))
  if (m.tasks.length === 0) {
    return [blank(), heading('Tasks', m.cols, '0/0'), [seg('No todo list yet.', { dim: true })]]
  }
  // The progress bar sits on the heading row, after the title.
  const out: Line[] = [blank(), [seg(`Tasks ${done.length}/${m.tasks.length} `, { bold: true, color: 'cyan' }), ...taskBar(done.length, m.tasks.length, barW)]]
  for (const t of active) out.push(taskLine(t, m.cols))
  for (const t of pending) out.push(taskLine(t, m.cols))
  const shown = done.slice(-MAX_DONE_TASKS)
  if (done.length > shown.length) out.push([seg(`✔ … ${done.length - shown.length} earlier done`, { dim: true })])
  for (const t of shown) out.push(taskLine(t, m.cols))
  return out
}

function egmLines(m: ViewModel): Line[] {
  const g = m.egm
  if (!g) return []
  const out: Line[] = [blank(), heading(`EGM · ${g.skill}`, m.cols, g.doneMin !== undefined ? `done in ${fmtMin(g.doneMin)}` : '')]
  for (const s of g.steps) {
    out.push(
      clip(
        [
          seg(s.done ? '✔ ' : '▶ ', { color: s.done ? 'green' : 'cyan' }),
          seg(s.type.replace('egm:', ''), { dim: s.done }),
          ...(s.label ? [seg(` · ${s.label}`, { dim: true })] : []),
          seg(` · ${fmtMin(s.min)}`, { dim: true }),
        ],
        m.cols,
      ),
    )
  }
  for (const x of g.left) out.push(clip([seg('○ ', { dim: true }), seg(`${x.type.replace('egm:', '')} · est ${fmtMin(x.estMin)}`, { dim: true })], m.cols))
  return out
}

function forecastLines(m: ViewModel): Line[] {
  const f = m.forecast
  const out: Line[] = [blank(), heading('Forecast', m.cols)]
  if (!f) {
    out.push([seg('Nothing left to estimate.', { dim: true })])
    return out
  }
  out.push(
    clip(
      [
        seg(f.fits ? '✔ Fits' : '✘ Will not fit', { bold: true, color: f.fits ? 'green' : 'red' }),
        seg(` · ETA ${fmtMin(f.remainingMin)}`, { bold: true }),
        seg(` (${fmtMin(f.lowMin)}–${fmtMin(f.highMin)})`, { dim: true }),
      ],
      m.cols,
    ),
  )
  out.push(clip([seg(`~${fmtTok(f.tokens)} tok · ~${f.pctNeeded.toFixed(0)}% of the 5h limit`)], m.cols))
  out.push(clip([seg(f.reason, { dim: true })], m.cols))
  return out
}

/** The whole pane as lines for `m.cols` cells across. */
export function buildView(m: ViewModel): Line[] {
  const compact = m.cols < COMPACT_BELOW
  const out: Line[] = [heading('Limits', m.cols)]
  const w = barWidth('5h   ', [{ l: m.five, est: m.estPct }, { l: m.week, est: 0 }], m.cols, m.now)
  out.push(limitRow('5h   ', m.five, m.estPct, m.cols, m.now, w))
  out.push(limitRow('Week ', m.week, 0, m.cols, m.now, w))
  out.push(...guardLines(m))
  if (!compact) {
    out.push([
      seg('█', { color: 'green' }),
      seg(' used  ', { dim: true }),
      seg('█', { color: 'white' }),
      seg(' estimated for the tasks left  ', { dim: true }),
      seg('░', { dim: true }),
      seg(' unused', { dim: true }),
    ])
  }
  out.push(clip([seg(`Session ${fmtTok(m.session.tokens)} tok · $${m.session.usd.toFixed(2)}`, { dim: true })], m.cols))
  out.push(...agentLines(m, compact))
  out.push(...taskLines(m))
  out.push(...egmLines(m))
  out.push(...forecastLines(m))
  out.push(blank())
  const md = m.model
  if (compact) {
    out.push(clip([seg(`Learned from ${md.nAll + md.nTurn + md.nAgent} samples${md.learning ? ' · still learning' : ''}`, { dim: true })], m.cols))
  } else {
    out.push(
      clip(
        [seg(`Model ${md.n} ETA samples · llm ×${md.correction.toFixed(2)} · ±${(md.mape * 100).toFixed(0)}% · ${fmtTok(md.tokPerMin)} tok/min · ${md.pctPerMtok.toFixed(1)}%/Mtok${md.learning ? ' · still learning' : ''}`, { dim: true })],
        m.cols,
      ),
    )
    out.push(clip([seg(`Learned from ${md.nAll} tasks · ${md.nTurn} turns · ${md.nAgent} agent runs · ${md.nRate} rate readings`, { dim: true })], m.cols))
  }
  // Whatever a section drew, no line is wider than the pane.
  return out.map(l => clip(l, m.cols))
}

/** The one-line status under the prompt: guard marker, 5h meter with its reset, week, then ETA and the verdict. */
export function statusLine(m: Pick<ViewModel, 'five' | 'week' | 'guard' | 'forecast' | 'now'>): string {
  const parts: string[] = []
  const g = m.guard
  const mark = !g ? '' : g.phase === 'waiting' ? '‖ ' : g.phase === 'writing' ? '✎ ' : '⧗ '
  if (m.five) {
    const f = Math.round((Math.min(100, Math.max(0, m.five.pct)) / 100) * 6)
    const r = reset(m.five, m.now)
    parts.push(`${mark}5h ${'█'.repeat(f)}${'░'.repeat(6 - f)} ${m.five.pct.toFixed(0)}%${r ? ` ↻${r}` : ''}`)
  } else {
    parts.push(`${mark}5h --`)
  }
  if (m.week) parts.push(`wk ${m.week.pct.toFixed(0)}%`)
  if (m.forecast) {
    parts.push(`ETA ${fmtMin(m.forecast.remainingMin)} · ~${fmtTok(m.forecast.tokens)} tok · ${m.forecast.fits ? '✔ fits' : "✘ WON'T FIT"}`)
  }
  return parts.join(' · ')
}
