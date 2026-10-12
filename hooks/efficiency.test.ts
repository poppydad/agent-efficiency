import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRun, Rollups } from '../types'
import { MAX_RUNS, compact, evaluate, parseJudgements, repoSlug, summarize, tierOf } from './evaluate'

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'a1',
    agentId: 'a1',
    status: 'done',
    startedAt: 1_760_000_000_000,
    description: 'task',
    subagentType: 'general-purpose',
    model: 'claude-opus-5-5',
    promptExcerpt: '',
    toolCalls: 1,
    edits: 0,
    toolErrors: 0,
    tools: ['Bash'],
    durationMs: 8000,
    usage: { input: 3000, output: 300, cacheRead: 40000, cacheWrite: 0 },
    reason: 'answer',
    ...over,
  }
}

describe('tierOf', () => {
  test('maps ids and aliases to tiers', () => {
    expect(tierOf('claude-haiku-5-5')).toBe('haiku')
    expect(tierOf('sonnet')).toBe('sonnet')
    expect(tierOf('claude-opus-5-5[1m]')).toBe('opus')
    expect(tierOf('claude-fable-5-1')).toBe('opus')
    expect(tierOf('gpt-x')).toBe(undefined)
  })
})

describe('evaluate', () => {
  test('a trivial task on Opus is over-provisioned, Haiku suggested', () => {
    const ev = evaluate(run())
    expect(ev.suggested).toBe('haiku')
    expect(ev.verdict).toBe('over-provisioned')
    expect(ev.score).toBe(40)
  })

  test('the same task on Haiku is right-sized', () => {
    const ev = evaluate(run({ model: 'claude-haiku-5-5' }))
    expect(ev.verdict).toBe('right-sized')
    expect(ev.score).toBe(100)
  })

  test('a moderate edit task wants Sonnet', () => {
    const ev = evaluate(run({ edits: 2, toolCalls: 12, usage: { input: 9000, output: 4000, cacheRead: 80000, cacheWrite: 0 } }))
    expect(ev.suggested).toBe('sonnet')
    expect(ev.verdict).toBe('over-provisioned')
    expect(ev.score).toBe(70)
  })

  test('a heavy multi-file change on Opus is right-sized', () => {
    const ev = evaluate(
      run({
        edits: 9,
        toolCalls: 60,
        tools: ['Read', 'Edit', 'Bash', 'Grep', 'Write'],
        usage: { input: 20000, output: 25000, cacheRead: 400000, cacheWrite: 20000 },
      }),
    )
    expect(ev.suggested).toBe('opus')
    expect(ev.verdict).toBe('right-sized')
  })

  test('Haiku tripping over its tools is under-provisioned', () => {
    const ev = evaluate(run({ model: 'claude-haiku-5-5', toolCalls: 8, toolErrors: 4 }))
    expect(ev.suggested).toBe('sonnet')
    expect(ev.verdict).toBe('under-provisioned')
    expect(ev.score).toBe(55)
  })

  test('an aborted run is not judged', () => {
    const ev = evaluate(run({ reason: 'aborted' }))
    expect(ev.verdict).toBe('inconclusive')
    expect(ev.score).toBe(null)
  })

  test('an unknown model is not judged', () => {
    expect(evaluate(run({ model: 'mystery' })).verdict).toBe('inconclusive')
  })
})

describe('compact', () => {
  test('keeps the newest MAX_RUNS and folds the rest into daily rollups', () => {
    const day = 86_400_000
    const now = 1_760_000_000_000
    const old = Array.from({ length: MAX_RUNS }, (_, i) =>
      run({ id: `r${i}`, startedAt: now - day + i, evaluation: evaluate(run()) }),
    )
    const added = Array.from({ length: 5 }, (_, i) => run({ id: `n${i}`, startedAt: now + i }))
    const { runs, rollups } = compact(old, added, {}, now)
    expect(runs.length).toBe(MAX_RUNS)
    expect(runs[runs.length - 1]!.id).toBe('n4')
    expect(runs[0]!.id).toBe('r5')
    const days = Object.values(rollups)
    expect(days.length).toBe(1)
    const opus = days[0]!['claude-opus-5-5']!
    expect(opus.runs).toBe(5)
    expect(opus.overProvisioned).toBe(5)
    expect(opus.outputTokens).toBe(1500)
  })

  test('drops rollups older than 90 days', () => {
    const now = Date.UTC(2026, 9, 11)
    const rollups: Rollups = {
      '2026-01-01': { m: { runs: 1, inputTokens: 0, outputTokens: 0, toolCalls: 0, durationMs: 0, overProvisioned: 0, underProvisioned: 0 } },
      '2026-10-01': { m: { runs: 2, inputTokens: 0, outputTokens: 0, toolCalls: 0, durationMs: 0, overProvisioned: 0, underProvisioned: 0 } },
    }
    const out = compact([], [], rollups, now).rollups
    expect(Object.keys(out)).toEqual(['2026-10-01'])
  })

  test('re-adding a run replaces it rather than duplicating', () => {
    const { runs } = compact([run({ id: 'x', toolCalls: 1 })], [run({ id: 'x', toolCalls: 7 })], {}, 0)
    expect(runs.length).toBe(1)
    expect(runs[0]!.toolCalls).toBe(7)
  })
})

describe('helpers', () => {
  test('summarize groups by model', () => {
    const s = summarize([
      run({ id: '1', evaluation: { suggested: 'haiku', verdict: 'over-provisioned', score: 40, why: '' } }),
      run({ id: '2', evaluation: { suggested: 'opus', verdict: 'right-sized', score: 100, why: '' } }),
      run({ id: '3', model: 'claude-haiku-5-5', evaluation: { suggested: 'haiku', verdict: 'right-sized', score: 100, why: '' } }),
    ])
    expect(s[0]).toEqual({ model: 'claude-opus-5-5', runs: 2, avgScore: 70, overProvisioned: 1, underProvisioned: 0 })
    expect(s[1]!.model).toBe('claude-haiku-5-5')
  })

  test('repoSlug is the basename plus a stable hash', async () => {
    const a = await repoSlug('/Users/x/flipboard')
    expect(a).toMatch(/^flipboard-[0-9a-f]{6}$/)
    expect(await repoSlug('/Users/x/flipboard')).toBe(a)
    expect(await repoSlug('/Users/y/flipboard')).not.toBe(a)
  })

  test('parseJudgements reads a fenced JSON array and skips junk', () => {
    const text = 'Sure:\n```json\n[{"id":"a","model":"haiku","reason":"lookup"},{"id":"b","model":"gpt"},{"model":"opus"}]\n```'
    expect(parseJudgements(text)).toEqual([{ id: 'a', suggested: 'haiku', reason: 'lookup' }])
    expect(parseJudgements('no json here')).toEqual([])
  })
})

/** In-memory fs + env beneath the plugin, so the hooks run end to end. */
function fakeHost(on: On, files: Map<string, string>) {
  on('env.get', () => ({ value: '/home/tester' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/work/repo/.git' || files.has(e.path) }))
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'sub1' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
}

test('a subagent run is tracked, judged and saved under the repo folder', async ($, on) => {
  const files = new Map<string, string>()
  fakeHost(on, files)

  await $.session.start({ cwd: '/work/repo/sub', surface: 'terminal', isInteractive: true })
  const slug = await repoSlug('/work/repo')
  const dir = `/home/tester/.claude/agent-efficiency/${slug}`
  expect(JSON.parse(files.get(`${dir}/meta.json`)!).repo).toBe('/work/repo')

  await $.agent.spawn({
    tool_use_id: 't1',
    prompt: 'add up the 2 times table',
    description: 'Times-2 table sum',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  } as never)

  const PANE = { component: 'Pane', requestId: 'agent-efficiency', props: { title: 'Agent efficiency', isFocused: false, bodyColumns: 60, seat: 'dock' } }
  const live = await $.ui.mount({ plugin: 'agent-efficiency', surface: 'terminal', ...PANE } as never)
  expect(await live.find({ type: 'Text', text: /running · 0 tools/ })).toBeDefined()
  expect(files.has(`${dir}/runs.json`)).toBe(false)

  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', input: { command: 'python3 -c 1' }, agentId: 'sub1' } as never)
  // a main-loop tool call must not be attributed to the subagent
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', input: { file_path: '/x' } } as never)

  await $.turn.complete({
    answer: 'Total sum: 10100',
    durationMs: 8200,
    isAborted: false,
    turnId: 'turn1',
    agentId: 'sub1',
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 2000, output_tokens: 200, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 },
  } as never)

  const saved = JSON.parse(files.get(`${dir}/runs.json`)!) as AgentRun[]
  expect(saved.length).toBe(1)
  expect(saved[0]!.status).toBe('done')
  expect(saved[0]!.toolCalls).toBe(1)
  expect(saved[0]!.tools).toEqual(['Bash'])
  expect(saved[0]!.durationMs).toBe(8200)
  expect(saved[0]!.usage!.output).toBe(200)
  expect(saved[0]!.evaluation!.verdict).toBe('over-provisioned')
  expect(saved[0]!.evaluation!.suggested).toBe('haiku')
  expect(await live.find({ type: 'Text', text: /over-provisioned → use haiku/ })).toBeDefined()
  await live.unmount()
  expect(saved[0]!.description).toBe('Times-2 table sum')
  expect(files.has(`${dir}/rollups.json`)).toBe(true)

  // a later SendMessage turn of the same subagent is logged as its own run
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', input: { file_path: '/a', old_string: 'a', new_string: 'b' }, agentId: 'sub1' } as never)
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 'turn2', agentId: 'sub1', reason: 'answer' } as never)
  const again = JSON.parse(files.get(`${dir}/runs.json`)!) as AgentRun[]
  expect(again.length).toBe(2)
  expect(again[1]!.id).toBe('sub1#2')
  expect(again[1]!.edits).toBe(1)

  // an engine fork's turn (never spawned) is ignored
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't3', agentId: 'compact-fork', reason: 'answer' } as never)
  expect((JSON.parse(files.get(`${dir}/runs.json`)!) as AgentRun[]).length).toBe(2)
})

test('the pane draws session runs and repo history on terminal and desktop', async ($, on) => {
  const files = new Map<string, string>()
  fakeHost(on, files)
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 't1', prompt: 'p', description: 'Lookup task', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  } as never)
  await $.turn.complete({
    answer: 'x', durationMs: 3000, isAborted: false, turnId: 'a', agentId: 'sub1', reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-efficiency',
      surface,
      component: 'Pane',
      requestId: 'agent-efficiency',
      props: { title: 'Agent efficiency', isFocused: false, bodyColumns: 48, seat: 'dock' },
    } as never)
    expect(await ui.find({ type: 'Text', text: /Lookup task/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /use haiku/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Repo history \(1 runs kept\)/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/agent-efficiency-review stores Haiku verdicts', async ($, on) => {
  const files = new Map<string, string>()
  fakeHost(on, files)
  let asked = ''
  on('model.complete', (_$, e) => {
    asked = `${e.model}|${e.prompt}`
    return {
      value: {
        isAnswered: true,
        text: '[{"id":"sub1","model":"haiku","reason":"simple arithmetic"}]',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    } as never
  })
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 't1', prompt: 'sum it', description: 'Sum', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  } as never)
  await $.turn.complete({ answer: 'x', durationMs: 10, isAborted: false, turnId: 'a', agentId: 'sub1', reason: 'answer' } as never)

  const out = await $.command.run({ command: 'agent-efficiency-review', args: '5', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
  expect(asked.startsWith('haiku|')).toBe(true)
  expect(asked).toContain('"id":"sub1"')
  expect((out as { text: string }).text).toContain('opus → haiku')

  const dir = `/home/tester/.claude/agent-efficiency/${await repoSlug('/work/repo')}`
  const saved = JSON.parse(files.get(`${dir}/runs.json`)!) as AgentRun[]
  expect(saved[0]!.judgement!.suggested).toBe('haiku')
})
