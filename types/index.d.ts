export type Tier = 'haiku' | 'sonnet' | 'opus'

export type Verdict = 'right-sized' | 'over-provisioned' | 'under-provisioned' | 'inconclusive'

export type RunUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Evaluation = {
  /** Tier of the model the run actually used; undefined when the id is unrecognised. */
  tier?: Tier
  /** Cheapest tier the heuristic thinks would have done the job. */
  suggested: Tier
  verdict: Verdict
  /** 0-100; null when the run ended early and can't be judged. */
  score: number | null
  why: string
}

export type Judgement = {
  suggested: Tier
  reason: string
  at: number
}

export type AgentRun = {
  /** Unique per run: agentId, plus a counter when a subagent is resumed. */
  id: string
  agentId: string
  status: 'running' | 'done'
  startedAt: number
  endedAt?: number
  description: string
  subagentType: string
  requestedModel?: string
  model: string
  promptExcerpt: string
  toolCalls: number
  edits: number
  toolErrors: number
  tools: string[]
  durationMs?: number
  usage?: RunUsage
  reason?: string
  evaluation?: Evaluation
  judgement?: Judgement
}

export type ModelRollup = {
  runs: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  durationMs: number
  overProvisioned: number
  underProvisioned: number
}

/** day (YYYY-MM-DD) -> model id -> totals */
export type Rollups = Record<string, Record<string, ModelRollup>>

export type RepoInfo = {
  root: string
  dir: string
}

export type ModelSummary = {
  model: string
  runs: number
  avgScore: number | null
  overProvisioned: number
  underProvisioned: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-efficiency': {
      repo: RepoInfo | null
      runs: AgentRun[]
      history: ModelSummary[]
      historyRuns: number
    }
  }
}
