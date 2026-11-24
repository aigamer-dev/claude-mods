export type Task = {
  id: string
  text: string
  /** The model's own estimate in minutes, parsed from "(~12m)" on the todo. */
  eta?: number
  status: 'pending' | 'in_progress' | 'completed'
  startedAt?: number
  doneAt?: number
  tokStart?: number
  /** Effective tokens used when the task finished. */
  tokDone?: number
}

export type EgmStep = {
  /** The tool_use_id of the Agent call, so two hooks never log one step twice. */
  id: string
  type: string
  label: string
  startedAt: number
  doneAt?: number
}

export type EgmRun = {
  skill: string
  startedAt: number
  doneAt?: number
  steps: EgmStep[]
}

export type Limit = { pct: number; resetsAt?: string }

export type Usage = {
  /** Effective tokens this session has used (cache reads weighted 0.1). */
  tokens: number
  usd: number
  fiveHour?: Limit
  week?: Limit
}

declare module 'claude-code' {
  interface PluginState {
    'usage-eta': {
      tasks: Shaped<Task[]>
      egm: Shaped<EgmRun | null>
      usage: Shaped<Usage>
    }
  }
}
