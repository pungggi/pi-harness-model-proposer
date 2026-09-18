// The dedicated-model proposer for pi-continual-harness.
//
// /refine (in pi-continual-harness) splits into PROPOSE then APPLY. This package
// owns one PROPOSE strategy, registered under the name "model":
//   - build a strict prompt (current state digest + trajectory evidence) asking
//     for a JSON array of CRUD deltas;
//   - call the one-shot `complete` closure the harness injects into ProposeInput
//     (built from ctx.modelRegistry; a hidden completion that bypasses the agent
//     loop);
//   - leniently parse, then VALIDATE + SANITIZE each delta against the current
//     state before returning it — because the harness's applyDeltas is
//     all-or-nothing and re-throws on unknown ids, so a single hallucinated id
//     would abort the whole batch. Unknown-id updates/deletes and evidence-less
//     creates are dropped, never applied;
//   - return ProposedDelta[] + ModelCallTelemetry, which the harness records in
//     the harness-refinement audit entry (branchable via /tree). So the model
//     call is hidden from the transcript but its spend (model/tokens/latency) and
//     its proposals are audited.
//
// Select with `/refine --proposer model` or `"proposer": "model"` in the harness
// config. Pure given an injected `complete`, so it is fully unit-testable.

import type {
  ComponentKind,
  CompleteResult,
  DeltaProposer,
  ModelCallTelemetry,
  ProposedDelta,
  ProposeInput,
  ProposeResult,
} from "pi-continual-harness";
import {
  DEFAULT_MAX_DELTAS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  loadConfig,
  type ModelProposerConfig,
} from "./config.js";

const PROPOSER_NAME = "model";

const PROPOSER_SYSTEM_PROMPT = [
  "You are the /refine optimizer for the Continual Harness.",
  "Propose small, surgical CRUD deltas to the harness state, grounded ONLY in the",
  "provided trajectory evidence. Output ONLY a JSON array of delta objects — no",
  "prose, no code fences, no commentary.",
].join(" ");

const KINDS: readonly ComponentKind[] = ["prompt", "memory", "skill", "subagent"];

function isScope(v: unknown): v is "global" | "project" {
  return v === "global" || v === "project";
}

function isKind(v: unknown): v is ComponentKind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

/** Clamp a model-provided importance into [0,1]; undefined if not a finite number. */
function coerceImportance(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function truncate(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Strip code fences / preface so a fenced JSON array still parses. Returns the
 *  substring of the first '[' through the matching last ']'. */
export function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return text;
  return text.slice(start, end + 1);
}

/** Build the prompt: schema + rules + a digest of the current state (so the model
 *  can update/delete by real id — project-scoped items are tagged with their
 *  scope so it can avoid duplicating project facts as global) + the trajectory
 *  evidence. */
export function buildPrompt(input: ProposeInput): string {
  const digest =
    input.state.items.length === 0
      ? "(no existing items)"
      : input.state.items
          .map(
            (i) =>
              `- [${i.id}] kind=${i.kind} importance=${i.importance.toFixed(2)}${i.active ? "" : " inactive"}${
                i.scope === "project" ? ` scope=project(${i.project ?? ""})` : ""
              }: ${i.content}`,
          )
          .join("\n");
  return [
    "Each array element is exactly one of:",
    '- {"op":"create","kind":"prompt|memory|skill|subagent","content":"...","evidence":"...","importance":0.0-1.0,"scope":"global|project"}',
    '- {"op":"update","id":"h_xxxx","content":"...","evidence":"...","importance":0.0-1.0,"active":true|false,"scope":"global|project"}',
    '- {"op":"delete","id":"h_xxxx","reason":"..."}',
    "",
    "Rules:",
    "- For update/delete, use ONLY ids present in the current state below.",
    "- Every create MUST include concrete evidence drawn from the trajectory.",
    "- Prefer updating an existing item over creating a near-duplicate.",
    '- "scope" is the durable-layer placement (default "global"). Set "project" ONLY when the item is useful exclusively in THIS project (deploy procedures, project architecture, local conventions) — the project slug is stamped server-side. A scope-only update (just id + scope) is valid and moves an item between layers.',
    "- Keep prompt notes terse and behavioral; memory facts specific; skill/subagent entries reusable, not one-task.",
    `- Emit at most ${DEFAULT_MAX_DELTAS} deltas. If nothing durable is worth recording, output [].`,
    "",
    `## Current state (${input.state.items.length} item(s))`,
    digest,
    "",
    "## Trajectory evidence",
    input.evidence,
  ].join("\n");
}

type ParseOutcome = { ok: true; deltas: ProposedDelta[]; dropped: number } | { ok: false; error: string };

/** Parse + validate + sanitize the model output into safe deltas. Deltas that
 *  don't conform, reference unknown ids, or lack required fields are DROPPED
 *  (counted in `dropped`) rather than returned — this keeps applyDeltas's
 *  all-or-nothing guarantee from aborting the whole batch on one bad delta. */
export function parseDeltas(text: string, maxDeltas: number, input: ProposeInput): ParseOutcome {
  let arr: unknown;
  try {
    arr = JSON.parse(extractJsonArray(text));
  } catch {
    return { ok: false, error: "model output was not valid JSON" };
  }
  if (!Array.isArray(arr)) {
    return { ok: false, error: "model output was not a JSON array" };
  }

  const knownIds = new Set(input.state.items.map((i) => i.id));
  // Track ids deleted earlier in this batch so a later update/delete of the same
  // id is dropped here, not handed to applyDeltas (which would throw on the
  // now-missing id and abort the whole batch). runRefine also guards this, but
  // dropping here keeps the audit honest about what the proposer intended.
  const deletedIds = new Set<string>();
  const deltas: ProposedDelta[] = [];
  let dropped = 0;
  for (const raw of arr) {
    const d = sanitizeDelta(raw, knownIds, deletedIds);
    if (!d) {
      dropped++;
      continue;
    }
    if (deltas.length >= maxDeltas) {
      dropped++;
      continue;
    }
    if (d.delta.op === "delete") deletedIds.add(d.delta.id);
    deltas.push(d);
  }
  return { ok: true, deltas, dropped };
}

/** Validate one raw object against the Delta union + current state. Returns null
 *  for anything that must not reach applyDeltas. */
export function sanitizeDelta(
  raw: unknown,
  knownIds: Set<string>,
  deletedIds: Set<string> = new Set(),
): ProposedDelta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  if (o["op"] === "create") {
    const kind = isKind(o["kind"]) ? o["kind"] : undefined;
    const content = nonEmptyString(o["content"]);
    const evidence = nonEmptyString(o["evidence"]);
    if (!kind || content === undefined || evidence === undefined) return null;
    const importance = coerceImportance(o["importance"]);
    // Durable-layer scope (harness 0.9+): whitelisted so the model can place
    // clearly project-specific creates in the project layer. The slug is
    // stamped server-side (never trusted from the model). Garbage → omitted,
    // which defaults the item to global.
    const scope = isScope(o["scope"]) ? o["scope"] : undefined;
    const delta = {
      op: "create" as const,
      kind,
      content,
      evidence,
      ...(importance !== undefined ? { importance } : {}),
      ...(scope !== undefined ? { scope } : {}),
    };
    return { delta, rationale: `model create (${kind}${scope === "project" ? ", project scope" : ""}): ${truncate(content)}` };
  }

  if (o["op"] === "update") {
    const id = typeof o["id"] === "string" ? o["id"] : undefined;
    if (id === undefined || !knownIds.has(id) || deletedIds.has(id)) return null;
    const content = nonEmptyString(o["content"]);
    const evidence = nonEmptyString(o["evidence"]);
    const importance = coerceImportance(o["importance"]);
    const active = typeof o["active"] === "boolean" ? o["active"] : undefined;
    // A scope-only update (id + scope, nothing else) is a legitimate layer move
    // — count scope toward "something to update".
    const scope = isScope(o["scope"]) ? o["scope"] : undefined;
    if (
      content === undefined &&
      evidence === undefined &&
      importance === undefined &&
      active === undefined &&
      scope === undefined
    ) {
      return null; // nothing to update
    }
    const delta = {
      op: "update" as const,
      id,
      ...(content !== undefined ? { content } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
      ...(importance !== undefined ? { importance } : {}),
      ...(active !== undefined ? { active } : {}),
      ...(scope !== undefined ? { scope } : {}),
    };
    return { delta, rationale: `model update ${id}${scope !== undefined ? ` (scope → ${scope})` : ""}` };
  }

  if (o["op"] === "delete") {
    const id = typeof o["id"] === "string" ? o["id"] : undefined;
    const reason = nonEmptyString(o["reason"]);
    if (id === undefined || !knownIds.has(id) || deletedIds.has(id) || reason === undefined) return null;
    return { delta: { op: "delete" as const, id, reason }, rationale: `model delete ${id}: ${truncate(reason)}` };
  }

  return null;
}

export interface CreateModelProposerOptions {
  /** Override the config source (for tests). Defaults to loadConfig(). */
  getConfig?: () => Promise<ModelProposerConfig>;
}

/**
 * Build the dedicated-model proposer. Registered under the name "model" so it is
 * selectable via `/refine --proposer model` or `"proposer": "model"` in the
 * harness config. Config is read lazily on each propose() (edits to
 * ~/.pi/agent/harness-model.json apply without a reload).
 */
export function createModelProposer(options: CreateModelProposerOptions = {}): DeltaProposer {
  const getConfig = options.getConfig ?? loadConfig;
  return {
    name: PROPOSER_NAME,
    async propose(input): Promise<ProposeResult> {
      const started = Date.now();
      const elapsed = (): number => Date.now() - started;

      // No model reachable in this session → audited no-op (the harness records
      // this in the refine entry; nothing is applied, nothing throws).
      if (!input.complete) {
        return {
          deltas: [],
          modelCall: { ok: false, error: "no model available (complete not injected)", latencyMs: elapsed() },
        };
      }

      // A custom getConfig could throw (the default loadConfig never does); treat
      // a throw as missing config so /refine degrades to an audited no-op.
      let config: ModelProposerConfig;
      try {
        config = await getConfig();
      } catch {
        config = {};
      }
      const prompt = buildPrompt(input);

      let result: CompleteResult;
      try {
        result = await input.complete(prompt, {
          systemPrompt: PROPOSER_SYSTEM_PROMPT,
          maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          ...(config.model ? { modelId: config.model } : {}),
        });
      } catch (err) {
        return {
          deltas: [],
          modelCall: {
            model: config.model ?? "active",
            ok: false,
            error: `model call failed: ${(err as Error).message}`,
            latencyMs: elapsed(),
          },
        };
      }

      const outcome = parseDeltas(result.text, config.maxDeltas ?? DEFAULT_MAX_DELTAS, input);
      if (!outcome.ok) {
        return {
          deltas: [],
          modelCall: {
            model: result.model ?? config.model ?? "active",
            ok: false,
            error: outcome.error,
            latencyMs: elapsed(),
            ...(result.usage ? { inputTokens: result.usage.input, outputTokens: result.usage.output } : {}),
          },
        };
      }

      const telemetry: ModelCallTelemetry = {
        model: result.model ?? config.model ?? "active",
        ok: true,
        latencyMs: elapsed(),
        ...(result.usage ? { inputTokens: result.usage.input, outputTokens: result.usage.output } : {}),
      };
      return { deltas: outcome.deltas, modelCall: telemetry };
    },
  };
}
