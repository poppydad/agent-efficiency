import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Rollups, Verdict } from '../types'
import {
  EDIT_TOOLS,
  compact,
  evaluate,
  fmtK,
  parseJudgements,
  repoSlug,
  summarize,
  tierOf,
} from './evaluate'

const PLUGIN = 'agent-efficiency'
const PANE = 'agent-efficiency'
const SESSION_CAP = 50

const repoAtom = atom({ plugin: 'agent-efficiency', key: 'repo' } as const, null)
const runsAtom = atom({ plugin: 'agent-efficiency', key: 'runs' } as const, [])
const historyAtom = atom({ plugin: 'agent-efficiency', key: 'history' } as const, [])
const historyRunsAtom = atom({ plugin: 'agent-efficiency', key: 'historyRuns' } as const, 0)

// Serialises writes to the repo's log files so two runs finishing together
// can't interleave a read-modify-write.
let writes: Promise<unknown> = Promise.resolve()
let paneOpened = false

async function findRoot($: EngineInterface, cwd: string): Promise<string> {
  let dir = cwd.replace(/\/+$/, '') || '/'
  for (;;) {
    if (await $.fs.exists(`${dir}/.git`).catch(() => false)) return dir
    const up = dir.slice(0, dir.lastIndexOf('/')) || '/'
    if (up === dir) return cwd
    dir = up
  }
}

async function readJson<T>($: EngineInterface, path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return fallback
  }
}

async function refreshHistory($: EngineInterface, runs: AgentRun[]) {
  await update($, historyAtom, () => summarize(runs))
  await update($, historyRunsAtom, () => runs.length)
}

function persist($: EngineInterface, finished: AgentRun) {
  writes = writes.then(async () => {
    const repo = await read($, repoAtom)
    if (!repo) return
    const runsPath = `${repo.dir}/runs.json`
    const rollupsPath = `${repo.dir}/rollups.json`
    const stored = await readJson<AgentRun[]>($, runsPath, [])
    const rollups = await readJson<Rollups>($, rollupsPath, {})
    const next = compact(stored, [finished], rollups, Date.now())
    await $.fs.write(runsPath, JSON.stringify(next.runs, null, 1))
    await $.fs.write(rollupsPath, JSON.stringify(next.rollups, null, 1))
    await refreshHistory($, next.runs)
  }).catch(err => void $.ui.log(`${PLUGIN}: could not save run: ${String(err)}`))
  return writes
}

/** The run a subagent's activity belongs to, starting a new one if it was resumed. */
async function liveRun($: EngineInterface, agentId: string): Promise<string | undefined> {
  const runs = await read($, runsAtom)
  const running = runs.find(r => r.agentId === agentId && r.status === 'running')
  if (running) return running.id
  const prior = [...runs].reverse().find(r => r.agentId === agentId)
  if (!prior) return undefined // an engine fork (compaction, memory), not a subagent we saw start
  const n = runs.filter(r => r.agentId === agentId).length + 1
  const id = `${agentId}#${n}`
  const resumed: AgentRun = {
    ...prior,
    id,
    status: 'running',
    startedAt: Date.now(),
    endedAt: undefined,
    toolCalls: 0,
    edits: 0,
    toolErrors: 0,
    tools: [],
    durationMs: undefined,
    usage: undefined,
    reason: undefined,
    evaluation: undefined,
    judgement: undefined,
    description: `${prior.description.replace(/ \(resumed\)$/, '')} (resumed)`,
  }
  await update($, runsAtom, list => [...list, resumed].slice(-SESSION_CAP))
  return id
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/\[.*\]$/, '')
}

function verdictColor(v: Verdict | undefined): string | undefined {
  if (v === 'right-sized') return 'success'
  if (v === 'over-provisioned') return 'warning'
  if (v === 'under-provisioned') return 'error'
  return undefined
}

function seconds(ms: number | undefined): string {
  if (ms === undefined) return '-'
  return ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'agent-efficiency',
        description: 'Open the agent efficiency pane (models, tokens, suggested models for subagents)',
      })
      await $.command.register({
        name: 'agent-efficiency-review',
        description: 'Ask Haiku to re-judge the last N subagent runs in this repo (default 10)',
        argumentHint: '[n]',
      })
    } catch (err) {
      void $.ui.log(`${PLUGIN}: could not register commands: ${String(err)}`)
    }
    const started = await next(e)

    try {
      const home = await $.env.get('HOME')
      if (home) {
        const root = await findRoot($, e.cwd)
        const dir = `${home}/.claude/agent-efficiency/${await repoSlug(root)}`
        await $.fs.write(`${dir}/meta.json`, JSON.stringify({ repo: root, lastSession: new Date().toISOString() }, null, 1))
        await update($, repoAtom, () => ({ root, dir }))
        await refreshHistory($, await readJson<AgentRun[]>($, `${dir}/runs.json`, []))
      }
    } catch (err) {
      void $.ui.log(`${PLUGIN}: could not set up the stats folder: ${String(err)}`)
    }
    return started
  })

  on('command.run', { command: 'agent-efficiency' }, async $ => {
    paneOpened = true
    await $.ui.open({ id: PANE, title: 'Agent efficiency' })
    const repo = await read($, repoAtom)
    return { text: `Agent efficiency pane opened. Logs: ${repo?.dir ?? '(not set up)'}` }
  })

  on('command.run', { command: 'agent-efficiency-review' }, async ($, e) => {
    const repo = await read($, repoAtom)
    if (!repo) return { text: 'The stats folder is not set up for this repo.' }
    const n = Math.min(25, Math.max(1, parseInt(e.args.trim(), 10) || 10))

    let reply = ''
    let judged: ReturnType<typeof parseJudgements> = []
    await (writes = writes.then(async () => {
      const runsPath = `${repo.dir}/runs.json`
      const stored = await readJson<AgentRun[]>($, runsPath, [])
      const batch = stored.filter(r => r.status === 'done').slice(-n)
      if (batch.length === 0) {
        reply = 'No finished subagent runs logged for this repo yet.'
        return
      }
      const lines = batch.map(r =>
        JSON.stringify({
          id: r.id,
          task: r.description,
          type: r.subagentType,
          model: r.model,
          prompt: r.promptExcerpt,
          toolCalls: r.toolCalls,
          tools: r.tools,
          edits: r.edits,
          toolErrors: r.toolErrors,
          outputTokens: r.usage?.output ?? 0,
          contextTokens: (r.usage?.input ?? 0) + (r.usage?.cacheRead ?? 0) + (r.usage?.cacheWrite ?? 0),
          durationMs: r.durationMs,
          ended: r.reason,
        }),
      )
      const answer = await $.model.complete({
        model: 'haiku',
        maxTokens: 3000,
        timeoutMs: 90000,
        system:
          'You audit which Claude model tier a coding subagent needed. Tiers, cheapest first: haiku (lookups, arithmetic, simple searches, short summaries), sonnet (ordinary multi-step coding, edits across a few files), opus (hard debugging, unfamiliar code, delicate multi-file changes, deep reasoning). Pick the CHEAPEST tier that would very likely have done the task equally well.',
        prompt: `Each line is one subagent run:\n${lines.join('\n')}\n\nReply with only a JSON array, one object per run: {"id": "<id>", "model": "haiku"|"sonnet"|"opus", "reason": "<under 20 words>"}`,
      })
      if (!answer.isAnswered) {
        reply = `Haiku review failed: ${answer.reason}.`
        return
      }
      judged = parseJudgements(answer.text)
      if (judged.length === 0) {
        reply = 'Haiku answered, but not in a form that could be read. Nothing was changed.'
        return
      }
      const at = Date.now()
      const byId = new Map(judged.map(j => [j.id, j]))
      const merged = stored.map(r => {
        const j = byId.get(r.id)
        return j ? { ...r, judgement: { suggested: j.suggested, reason: j.reason, at } } : r
      })
      await $.fs.write(runsPath, JSON.stringify(merged, null, 1))
      await update($, runsAtom, list =>
        list.map(r => {
          const j = byId.get(r.id)
          return j ? { ...r, judgement: { suggested: j.suggested, reason: j.reason, at } } : r
        }),
      )
      const rows = batch
        .filter(r => byId.has(r.id))
        .map(r => {
          const j = byId.get(r.id)!
          const used = tierOf(r.model) ?? r.model
          const mark = used === j.suggested ? 'ok' : `${used} → ${j.suggested}`
          return `- ${r.description} (${shortModel(r.model)}): ${mark}. ${j.reason}`
        })
      reply = `Haiku reviewed ${judged.length} of ${batch.length} runs:\n${rows.join('\n')}`
    }).catch(err => {
      reply = `Review failed: ${String(err)}`
    }))
    return { text: reply }
  })

  on('agent.spawn', async ($, e, next) => {
    const res = await next(e)
    try {
      if ('agentId' in res && res.agentId && !('deny' in res && res.deny)) {
        const run: AgentRun = {
          id: res.agentId,
          agentId: res.agentId,
          status: 'running',
          startedAt: Date.now(),
          description: e.description || e.subagentType,
          subagentType: e.subagentType,
          requestedModel: e.model,
          model: res.model,
          promptExcerpt: e.prompt.slice(0, 300),
          toolCalls: 0,
          edits: 0,
          toolErrors: 0,
          tools: [],
        }
        await update($, runsAtom, list => [...list, run].slice(-SESSION_CAP))
        if (!paneOpened) {
          paneOpened = true
          void $.ui.open({ id: PANE, title: 'Agent efficiency' }).catch(() => undefined)
        }
      }
    } catch (err) {
      void $.ui.log(`${PLUGIN}: could not track a spawn: ${String(err)}`)
    }
    return res
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) return next(e)
    const result = await next(e)
    try {
      const id = await liveRun($, e.agentId)
      if (id) {
        const tool = String(e.tool)
        const failed = 'isError' in result && result.isError === true
        await update($, runsAtom, list =>
          list.map(r =>
            r.id !== id
              ? r
              : {
                  ...r,
                  toolCalls: r.toolCalls + 1,
                  edits: r.edits + (EDIT_TOOLS.has(tool) && !failed ? 1 : 0),
                  toolErrors: r.toolErrors + (failed ? 1 : 0),
                  tools: r.tools.includes(tool) ? r.tools : [...r.tools, tool],
                },
          ),
        )
      }
    } catch (err) {
      void $.ui.log(`${PLUGIN}: could not count a tool call: ${String(err)}`)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) return result
    try {
      const id = await liveRun($, e.agentId)
      if (id) {
        let finished: AgentRun | undefined
        await update($, runsAtom, list =>
          list.map(r => {
            if (r.id !== id) return r
            const done: AgentRun = {
              ...r,
              status: 'done',
              endedAt: Date.now(),
              durationMs: e.durationMs,
              model: e.usage?.model || r.model,
              reason: e.reason,
              usage: e.usage && {
                input: e.usage.input_tokens,
                output: e.usage.output_tokens,
                cacheRead: e.usage.cache_read_input_tokens,
                cacheWrite: e.usage.cache_creation_input_tokens,
              },
            }
            done.evaluation = evaluate(done)
            finished = done
            return done
          }),
        )
        if (finished) await persist($, finished)
      }
    } catch (err) {
      void $.ui.log(`${PLUGIN}: could not record a finished run: ${String(err)}`)
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns ?? 60)
    const repo = await read($, repoAtom)
    const runs = await read($, runsAtom)
    const history = await read($, historyAtom)
    const historyRuns = await read($, historyRunsAtom)
    const home = repo?.dir.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/)?.[1]
    const where = repo ? (home ? repo.dir.replace(home, '~') : repo.dir) : 'stats folder not set up'
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 30) - 12 - history.length) / 3))

    return (
      <Box flexDirection="column">
        <Text bold>{clip(repo ? repo.root.split('/').pop() ?? '' : 'Agent efficiency', width)}</Text>
        <Text dimColor>{clip(where, width)}</Text>
        <Text> </Text>
        <Text bold>This session</Text>
        {runs.length === 0 && <Text dimColor>No subagents yet.</Text>}
        {runs.slice(-room).map(r => {
          const ev = r.evaluation
          const used = shortModel(r.model)
          const tokens = r.usage ? r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite : 0
          const head =
            r.status === 'running'
              ? `● ${clip(r.description, width - used.length - 4)}`
              : `${ev?.score ?? '–'} ${clip(r.description, width - used.length - 6)}`
          const pick = r.judgement?.suggested ?? ev?.suggested
          const tierUsed = tierOf(r.model)
          const suggestion =
            r.status === 'running'
              ? `running · ${r.toolCalls} tools`
              : ev?.verdict === 'inconclusive'
                ? `inconclusive · ${ev.why}`
                : pick && tierUsed && pick !== tierUsed
                  ? `${ev?.verdict ?? ''} → use ${pick}${r.judgement ? ' (haiku)' : ''}`
                  : `right-sized${r.judgement ? ' (haiku agrees)' : ''}`
          return (
            <Box flexDirection="column">
              <Text>
                <Text color={r.status === 'running' ? 'claude' : verdictColor(ev?.verdict)}>{head}</Text>
                <Text dimColor> {used}</Text>
              </Text>
              <Text color={r.status === 'running' ? undefined : verdictColor(ev?.verdict)} dimColor={r.status === 'running'}>
                {'  '}
                {clip(suggestion, width - 2)}
              </Text>
              {r.status === 'done' && (
                <Text dimColor>
                  {'  '}
                  {clip(`${fmtK(tokens)} tok · ${fmtK(r.usage?.output ?? 0)} out · ${r.toolCalls} tools · ${r.edits} edits · ${seconds(r.durationMs)}`, width - 2)}
                </Text>
              )}
            </Box>
          )
        })}
        <Text> </Text>
        <Text bold>Repo history ({historyRuns} runs kept)</Text>
        {history.length === 0 && <Text dimColor>Nothing logged yet.</Text>}
        {history.map(m => (
          <Text>
            <Text>{clip(shortModel(m.model), Math.max(8, width - 30)).padEnd(Math.min(16, Math.max(8, width - 30)))}</Text>
            <Text dimColor>
              {` ${String(m.runs).padStart(3)} runs · avg ${m.avgScore ?? '–'}`}
            </Text>
            {m.overProvisioned > 0 && <Text color="warning">{` · ${m.overProvisioned} over`}</Text>}
            {m.underProvisioned > 0 && <Text color="error">{` · ${m.underProvisioned} under`}</Text>}
          </Text>
        ))}
        <Text> </Text>
        <Text dimColor>{clip('/agent-efficiency-review asks Haiku to re-judge', width)}</Text>
      </Box>
    )
  })
}
