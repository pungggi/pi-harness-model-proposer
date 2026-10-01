# pi-harness-model-proposer

A **dedicated-model proposer** companion for
[pi-continual-harness](https://www.npmjs.com/package/pi-continual-harness) ([repo](https://github.com/pungggi/pi-continual-harness)) — the
online self-improvement layer for the [pi](https://pi.dev) coding agent.

pi-continual-harness's `/refine` splits into **propose** then **apply**, with the
propose stage pluggable via a registry. The built-in proposers are `steering`
(delegates reasoning to the agent loop — visible) and `dedupe` (rule-based, no
model). This package adds a third:

| Name | What it does |
|---|---|
| `model` | Makes its own one-shot LLM call (via the harness's injected `complete` closure) to propose evidence-backed CRUD deltas directly. The call is **hidden from the transcript but audited** — model, tokens, and latency are recorded in the `harness-refinement` entry (branchable via `/tree`). |

This is the alternate pi-continual-harness flags in its roadmap as
"interface-ready, intentionally not shipped": the hidden-model-spend tradeoff is
kept out of the core and resolved here by making the spend **audited** rather
than shipping it invisible.

## Install

```
pi install npm:pi-harness-model-proposer
```

Requires `pi-continual-harness >= 0.12.0` (and therefore `@earendil-works/pi-coding-agent >= 0.99.0`, which the harness itself peers on — installed together, the ranges stay compatible). Harness 0.12+ injects the `complete` closure, the optional `classify` closure, records `modelCall` telemetry, and accepts `scope` on deltas.

## Usage

Select the proposer per run or as the default:

```
/refine --proposer model          # one run
/refine 50 --proposer model       # with a lookback window
```

Or set it as the default in the harness config (`~/.pi/agent/harness.json`):

```json
{ "proposer": "model" }
```

It then also drives opt-in auto-refine (`autoRefine`) when that is enabled.

## How it works

1. `/refine` (in pi-continual-harness) gathers trajectory evidence and hands it —
   plus the current state and a one-shot `complete(prompt, opts?)` closure — to
   this proposer.
2. This proposer builds a **strict prompt**: a digest of the current state (so the
   model can `update`/`delete` by real id), the schema for the CRUD delta union,
   and the trajectory evidence. It asks for a **JSON array** of deltas only.
3. It calls `complete` (a hidden completion built by the harness from
   `ctx.modelRegistry`), honoring the agent abort signal and a token budget.
   Optionally gated/validated by the cheap classifier seam — see below.
4. It **parses, then validates + sanitizes** each delta against the current state
   before returning it. This is the safety-critical step: the harness's
   `applyDeltas` is all-or-nothing and re-throws on an unknown id, so a single
   hallucinated id would otherwise abort the whole batch. Unknown-id
   updates/deletes, evidence-less creates, and malformed entries are **dropped**,
   never applied.
5. It returns `ProposedDelta[]` + `ModelCallTelemetry`. The harness applies the
   deltas through its normal audited, branchable path and records the telemetry
   (model, input/output tokens, latency, ok/error) in the `harness-refinement`
   entry.

So the model call never appears in the agent transcript, but **what it cost and
what it proposed** are visible and reviewable, and every mutation still flows
through the same audited `applyDeltas` with `/tree` rollback.

### Classifier gate + validation (harness 0.12+)

When the harness has a **classifier** configured
(`"classifier": { "model": "typesafe/jev-latest" }` or a local llama.cpp
classifier in `harness.json`), it injects a cheap `classify` closure into the
propose input. This proposer can use it in two **opt-in** ways
(`~/.pi/agent/harness-model.json`):

| Knob | What it does |
|---|---|
| `"gate": true` | Asks **one** cheap yes/no before the completion — "does this trajectory contain a durable correction worth deltas?" — and **skips the model call entirely** when the answer is no. Saves hidden model spend on routine windows. |
| `"validate": true` | After the completion, asks the classifier to confirm each proposed delta is grounded in the evidence; rejected deltas are **dropped before** they can reach the all-or-nothing `applyDeltas`. |

Both are **fail-open**: `classify` is simply `undefined` when no classifier is
configured (degrade to the plain behavior above), and a classifier error or a
missing answer never blocks a refine — the classifier can only skip/narrow
work, never disable it. This is the same question and semantics the harness's
own `"autoRefine": { "gate": true }` uses, so with both enabled an auto-refine
run gates twice at the same cheap layer (once before spending the refine, once
before spending the completion) — the second gate only fires for runs that
passed the first. Classifier spend stays audited: a gate skip reports the
classifier call itself as the `modelCall` entry; otherwise the classifier's
token usage is folded into the completion's `modelCall` totals.

### Scope awareness (harness 0.9+)

The proposer is durable-layer aware: the state digest tags project-scoped items
with `scope=project(<slug>)`, and the schema offers an optional
`"scope":"global|project"` on `create`/`update` deltas. A **scope-only update**
(id + scope) is a legitimate layer move, so the proposer can re-scope misplaced
items during a `/refine`. The project slug itself is **never taken from the
model** — the harness stamps it server-side from the session cwd; a garbage
scope value is simply omitted (the item defaults to global).

## Configuration

Optional config at `~/.pi/agent/harness-model.json` (missing/malformed → defaults):

```json
{
  "model": "anthropic/claude-3-5-haiku",
  "maxOutputTokens": 4096,
  "maxDeltas": 20,
  "gate": false,
  "validate": false
}
```

- **`model`** — model id (`"provider/id"` or bare) for the proposal completion.
  When unset, the proposer uses the **active session model**.
- **`maxOutputTokens`** — token budget for the completion (default `4096`).
- **`maxDeltas`** — cap on deltas applied per run; excess is dropped to bound
  spend (default `20`).
- **`gate`** / **`validate`** — opt-in classifier hooks; see
  [Classifier gate + validation](#classifier-gate--validation-harness-012).
  Both require `classifier.model` in the **harness** config
  (`~/.pi/agent/harness.json`); without one they are no-ops.

## Behavior on failure

This proposer has no access to `ctx`, so it cannot fall back to the `steering`
proposer. Instead it degrades to an **audited no-op**: when there is no model,
the call fails, or the output is unparseable, it returns no deltas and records a
`modelCall` with `ok: false` + an error in the audit entry. Nothing throws; the
harness shows "applied 0". The classifier hooks fail **open** instead: a
missing or erroring classifier never changes the outcome (see above).

## Scope and non-goals

- **In scope:** the dedicated-model propose strategy, registered as `"model"`.
- **Out of scope:** the state store, `/refine`, the apply path, durable I/O,
  auto-refine cadence, outcome loop — all owned by pi-continual-harness. This
  package owns no state and makes no model calls of its own; it calls the
  `complete` closure the harness injects.

## License

MIT
