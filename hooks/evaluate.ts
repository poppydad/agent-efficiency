// Pure logic: no `$`, so the tests can call it directly.
import type { AgentRun, Evaluation, ModelSummary, Rollups, Tier } from '../types'

export const MAX_RUNS = 200
export const ROLLUP_DAYS = 90

const RANK: Record<Tier, number> = { haiku: 1, sonnet: 2, opus: 3 }
const TIERS: Tier[] = ['haiku', 'sonnet', 'opus']

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

/** Maps a model id or alias to a price tier. Fable sits with Opus at the top. */
export function tierOf(model: string | undefined): Tier | undefined {
  const m = (model ?? '').toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus') || m.includes('fable')) return 'opus'
  return undefined
}

/**
 * Scores how hard the run actually was and picks the cheapest tier that
 * should have managed it. Signals: files edited, tool calls, output size,
 * how much context it had to read, and how many distinct tools it needed.
 */
export function evaluate(run: AgentRun): Evaluation {
  const tier = tierOf(run.model)
  if (run.reason && run.reason !== 'answer') {
    return {
      tier,
      suggested: tier ?? 'sonnet',
      verdict: 'inconclusive',
      score: null,
      why: `ended early (${run.reason})`,
    }
  }

  const out = run.usage?.output ?? 0
  const read = (run.usage?.input ?? 0) + (run.usage?.cacheRead ?? 0) + (run.usage?.cacheWrite ?? 0)
  const reasons: string[] = []
  let points = 0

  if (run.edits >= 4) (points += 4), reasons.push(`${run.edits} edits`)
  else if (run.edits >= 1) (points += 2), reasons.push(`${run.edits} edit${run.edits > 1 ? 's' : ''}`)

  if (run.toolCalls > 50) (points += 3), reasons.push(`${run.toolCalls} tool calls`)
  else if (run.toolCalls > 20) (points += 2), reasons.push(`${run.toolCalls} tool calls`)
  else if (run.toolCalls > 5) points += 1

  if (out >= 20000) (points += 3), reasons.push(`${fmtK(out)} output`)
  else if (out >= 6000) (points += 2), reasons.push(`${fmtK(out)} output`)
  else if (out >= 1500) points += 1

  if (read > 150000) (points += 1), reasons.push(`${fmtK(read)} context`)
  if (run.tools.length >= 5) (points += 1), reasons.push(`${run.tools.length} distinct tools`)

  let suggested: Tier = points <= 1 ? 'haiku' : points <= 4 ? 'sonnet' : 'opus'

  // A cheap model that kept tripping over its tools was probably too small.
  const errorRatio = run.toolCalls > 0 ? run.toolErrors / run.toolCalls : 0
  const struggled = run.toolErrors >= 3 || (run.toolCalls >= 4 && errorRatio > 0.3)
  if (struggled) {
    reasons.push(`${run.toolErrors} tool errors`)
    if (tier && RANK[suggested] <= RANK[tier]) suggested = TIERS[Math.min(RANK[tier], 2)] ?? 'opus'
  }

  if (reasons.length === 0) reasons.push(`light task: ${run.toolCalls} tool calls, ${fmtK(out)} output`)

  if (!tier) {
    return { tier, suggested, verdict: 'inconclusive', score: null, why: `unknown model; ${reasons.join(', ')}` }
  }

  const gap = RANK[tier] - RANK[suggested]
  const verdict = gap > 0 ? 'over-provisioned' : gap < 0 ? 'under-provisioned' : 'right-sized'
  let score = 100 - 30 * Math.abs(gap)
  if (errorRatio > 0.3) score -= 15
  score = Math.max(0, Math.min(100, score))

  return { tier, suggested, verdict, score, why: reasons.join(', ') }
}

export function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Appends finished runs, keeps the newest MAX_RUNS in full, folds the rest
 * into per-day per-model rollups, and drops rollups older than ROLLUP_DAYS.
 */
export function compact(
  existing: AgentRun[],
  added: AgentRun[],
  rollups: Rollups,
  now: number,
): { runs: AgentRun[]; rollups: Rollups } {
  const seen = new Set(added.map(r => r.id))
  const all = [...existing.filter(r => !seen.has(r.id)), ...added].sort(
    (a, b) => a.startedAt - b.startedAt,
  )
  const overflow = all.length > MAX_RUNS ? all.slice(0, all.length - MAX_RUNS) : []
  const runs = all.slice(overflow.length)

  const next: Rollups = JSON.parse(JSON.stringify(rollups))
  for (const r of overflow) {
    const day = (next[dayOf(r.startedAt)] ??= {})
    const m = (day[r.model] ??= {
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      durationMs: 0,
      overProvisioned: 0,
      underProvisioned: 0,
    })
    m.runs += 1
    m.inputTokens += (r.usage?.input ?? 0) + (r.usage?.cacheRead ?? 0) + (r.usage?.cacheWrite ?? 0)
    m.outputTokens += r.usage?.output ?? 0
    m.toolCalls += r.toolCalls
    m.durationMs += r.durationMs ?? 0
    if (r.evaluation?.verdict === 'over-provisioned') m.overProvisioned += 1
    if (r.evaluation?.verdict === 'under-provisioned') m.underProvisioned += 1
  }

  const cutoff = dayOf(now - ROLLUP_DAYS * 86400000)
  for (const day of Object.keys(next)) if (day < cutoff) delete next[day]

  return { runs, rollups: next }
}

/** Per-model summary of the stored runs, most-used model first. */
export function summarize(runs: AgentRun[]): ModelSummary[] {
  const by = new Map<string, { runs: number; scores: number[]; over: number; under: number }>()
  for (const r of runs) {
    const s = by.get(r.model) ?? { runs: 0, scores: [], over: 0, under: 0 }
    s.runs += 1
    if (r.evaluation?.score != null) s.scores.push(r.evaluation.score)
    if (r.evaluation?.verdict === 'over-provisioned') s.over += 1
    if (r.evaluation?.verdict === 'under-provisioned') s.under += 1
    by.set(r.model, s)
  }
  return [...by.entries()]
    .map(([model, s]) => ({
      model,
      runs: s.runs,
      avgScore: s.scores.length ? Math.round(s.scores.reduce((a, b) => a + b, 0) / s.scores.length) : null,
      overProvisioned: s.over,
      underProvisioned: s.under,
    }))
    .sort((a, b) => b.runs - a.runs)
}

/** Folder name for a repo: its basename plus a short hash of the full path. */
export async function repoSlug(root: string): Promise<string> {
  const bytes = new TextEncoder().encode(root)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hex = [...digest.slice(0, 3)].map(b => b.toString(16).padStart(2, '0')).join('')
  const base = root.split('/').filter(Boolean).pop() ?? 'root'
  return `${base.replace(/[^A-Za-z0-9._-]/g, '_')}-${hex}`
}

/** Parses the Haiku reviewer's reply: a JSON array of { id, model, reason }. */
export function parseJudgements(text: string): { id: string; suggested: Tier; reason: string }[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: { id: string; suggested: Tier; reason: string }[] = []
  for (const item of raw) {
    const tier = tierOf(String(item?.model ?? ''))
    if (typeof item?.id === 'string' && tier) {
      out.push({ id: item.id, suggested: tier, reason: String(item.reason ?? '').slice(0, 200) })
    }
  }
  return out
}
