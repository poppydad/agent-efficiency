# agent-efficiency

A Claude Code mod that watches every subagent your sessions spawn, records which
model it ran on and what it actually did, and tells you whether a cheaper model
would have done the job just as well.

It shows this live in a side pane and keeps a small, bounded efficiency log per
repository under `~/.claude/agent-efficiency/`, so the picture builds up across
every session you run in that repo.

```
flipboard
~/.claude/agent-efficiency/flipboard-3fa9c1

This session
40 Count .ts files in engine/                    opus-5-5
  over-provisioned → use haiku
  21.4k tok · 118 out · 1 tools · 0 edits · 2.8s
100 Read spec/charset.json                       haiku-5-5
  right-sized (haiku agrees)
  37.2k tok · 245 out · 1 tools · 0 edits · 2.2s
● Trace POST /message to the canvas              opus-5-5
  running · 14 tools

Repo history (183 runs kept)
opus-5-5          97 runs · avg 64 · 41 over
sonnet-5-5        58 runs · avg 88 · 9 over
haiku-5-5         28 runs · avg 93 · 2 under

/agent-efficiency-review asks Haiku to re-judge
```

## Why

Subagents are often spawned on the parent's model by default, which is usually
the most expensive one. Plenty of delegated work — counting files, reading one
config, running a single command — doesn't need it. This mod makes that visible
per run, so you can choose models deliberately (in your prompts, your agent
definitions, or a `model:` field) instead of paying top-tier prices for lookups.

## Install

In a Claude Code terminal session:

```
/plugin install agent-efficiency --marketplace poppydad/agent-efficiency
```

Answer `y` to add the marketplace and pick the **user** scope so it loads in
every repo. It's active immediately and in every session started afterwards.

From a local clone instead:

```bash
git clone https://github.com/poppydad/agent-efficiency ~/claude-mods/agent-efficiency
claude plugin marketplace add ~/claude-mods/agent-efficiency
claude plugin install agent-efficiency@local-mods --scope user
```

A folder-sourced install reads straight from the clone, so edits take effect
after `/reload-plugins` — no reinstall.

## What it tracks

Only **subagents** (anything started through the Agent tool, including nested
ones and teammates). The main conversation isn't tracked — you can't change its
model per turn anyway, so there's no decision to evaluate.

For every subagent run:

| Field | Source |
| --- | --- |
| task description, agent type, prompt excerpt (300 chars) | `agent.spawn` |
| model requested vs. model actually resolved | `agent.spawn` result + the turn's reported usage |
| tool calls, distinct tools, files edited, tool errors | every `tool.call` inside that agent's loop |
| duration, input / output / cache-read / cache-write tokens, how it ended | `turn.complete` |
| heuristic verdict, score, suggested model, reasons | `hooks/evaluate.ts` |
| Haiku's verdict and reason (optional) | `/agent-efficiency-review` |

A subagent that's resumed later (e.g. via `SendMessage`) is logged as a new run
(`<agentId>#2`), since it's a separate unit of work. Engine-internal loops
(compaction, memory forks) are ignored because they were never spawned.

## How a run is judged

### Heuristic (free, every run)

Each finished run gets complexity points:

| Signal | Points |
| --- | --- |
| files edited | 1–3 → +2, 4+ → +4 |
| tool calls | 6–20 → +1, 21–50 → +2, 51+ → +3 |
| output tokens | 1.5k+ → +1, 6k+ → +2, 20k+ → +3 |
| context read (input + cache) | over 150k → +1 |
| distinct tools used | 5+ → +1 |

`0–1` points → **haiku**, `2–4` → **sonnet**, `5+` → **opus**.

If a run kept tripping over its tools (3+ errors, or more than 30% of 4+ calls
failing), the suggestion is bumped to one tier *above* what it ran on — a small
model that struggled was probably too small.

The tier the run used vs. the tier suggested gives the verdict:

- **right-sized** — same tier (score 100)
- **over-provisioned** — ran above what it needed (−30 per tier)
- **under-provisioned** — ran below what it needed (−30 per tier)
- **inconclusive** — interrupted, errored, or an unrecognised model; not scored

A high tool-error rate costs another 15 points. Model ids are mapped to tiers by
name: `haiku`, `sonnet`, and `opus` / `fable` (top tier).

All thresholds live at the top of `hooks/evaluate.ts` — tune them to taste.

### Haiku review (on demand, costs a little)

```
/agent-efficiency-review        # last 10 finished runs in this repo
/agent-efficiency-review 25     # up to 25
```

Sends a compact summary of each run (task, prompt excerpt, tools, edits, tokens,
duration) to Haiku and asks for the cheapest tier that would very likely have
done each task equally well, with a one-line reason. Verdicts are stored on the
runs and shown in the pane next to the heuristic's. The heuristic only sees
*shape*; Haiku also sees *what the task was*, so it catches things like "this
was one grep, it just produced a lot of output".

## Commands

| Command | What it does |
| --- | --- |
| `/agent-efficiency` | Opens the side pane and prints where this repo's logs live |
| `/agent-efficiency-review [n]` | Haiku re-judges the last *n* runs (default 10, max 25) |

The pane also opens by itself the first time a subagent starts in a session, as
long as the terminal is wide enough to dock it beside the transcript.

## Storage

```
~/.claude/agent-efficiency/
  flipboard-3fa9c1/        <repo folder name>-<6 hex chars of SHA-256 of its full path>
    meta.json              which repo this is, last session time
    runs.json              full detail for the newest 200 runs
    rollups.json           older runs, one line per model per day, kept 90 days
```

- **Per repo**: the repo is the nearest ancestor of the session's directory that
  contains `.git` (or the directory itself if there's none). The hash keeps two
  repos with the same folder name apart.
- **Bounded**: when `runs.json` passes 200 runs, the oldest are folded into
  `rollups.json` as per-day, per-model totals (runs, tokens, tool calls, time,
  over/under-provisioned counts), and rollups older than 90 days are deleted.
  A busy repo stays around 200 KB.
- Plain JSON, so you can analyse it with `jq` or Python if you want more than
  the pane shows.

## Design notes

- **It never gets in the way.** Every hook calls through to the engine first and
  does its bookkeeping afterwards inside `try/catch`; `agent.spawn` and
  `tool.call` also have `.catch` handlers that fall through, so a bug in this mod
  can't block a tool call or stop a subagent from starting.
- **Writes are serialised** within a session, so two agents finishing together
  can't interleave a read-modify-write. Two separate sessions in the same repo
  finishing at the same instant could, rarely, drop one run.
- **Pane state lives in `$.state`**, not module variables, so it survives hot
  reloads.
- Prompts are stored only as a 300-character excerpt, locally, in your home
  directory.

## Development

```
.claude-plugin/plugin.json        manifest
.claude-plugin/marketplace.json   makes this repo installable with /plugin install
hooks/hooks.json                  points at register.tsx
hooks/register.tsx                hooks: session.start, agent.spawn, tool.call,
                                  turn.complete, commands, the pane
hooks/evaluate.ts                 pure logic: tiers, scoring, retention, parsing
hooks/efficiency.test.ts          17 tests
types/index.d.ts                  $.state contract and data types
```

```bash
claude plugin validate .
claude plugin test .
```

The tests cover the scoring rules, retention and rollup expiry, repo hashing,
parsing Haiku's reply, and the hooks end to end against the engine's test kit
with an in-memory filesystem: a spawn → tool calls → completion flow, resumed
agents, ignored engine forks, the pane on both terminal and desktop surfaces,
and the review command.

Built against Claude Code 2.1.296's mod API, which is early access and may
change between releases.
