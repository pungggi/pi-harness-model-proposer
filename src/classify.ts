// Classifier integration for the dedicated-model proposer (harness 0.12+).
//
// pi-continual-harness injects an optional `classify` closure into ProposeInput
// when a classifier model is configured in harness.json (`"classifier":
// { "model": "typesafe/jev-latest" }` or a local llama.cpp classifier; pi ≥ 0.99
// modelRegistry.classify()). It answers batched yes/no questions from
// next-token label probabilities — far cheaper than a full `complete` call.
// This package uses it in two optional places (both opt-in via
// ~/.pi/agent/harness-model.json):
//
//  1. GATE (`"gate": true`): before spending the dedicated-model completion, ask
//     ONE bool question ("does this trajectory contain a durable correction
//     worth deltas?") and skip the model call entirely when the answer is no.
//     Reuses the harness's own exported `buildGateRequest` / `gateDecision`
//     (src/classify.ts over there) so the question is IDENTICAL to the
//     auto-refine gate — one calibration surface.
//  2. VALIDATE (`"validate": true`): after the completion, have the classifier
//     confirm each proposed delta is grounded in the evidence before returning
//     it — a precision filter on the model's output (see
//     buildValidateQuestions / filterValidated below).
//
// Contract (both): `classify` is `undefined` when no classifier is configured —
// every consumer degrades to the no-classifier behavior; the classifier is
// never required. All decisions fail OPEN: a classifier error or a missing
// answer proceeds/keeps, so a flaky classifier can only narrow spend and skip
// work, never block refinement (same principle as the harness's gate and
// dedupe confirmation). Classifier usage is folded into the modelCall telemetry
// so the spend stays audited.

import type { ClassifyBoolAnswer, ClassifyBoolResult, ProposedDelta } from "pi-continual-harness";
import { buildGateRequest, gateDecision } from "pi-continual-harness";

// Re-exported for consumers/tests of this package; the semantics live in the
// harness (single source of truth for the gate question + fail-open decision).
export { buildGateRequest, gateDecision };

/** Bound on validation questions per classify call, keeping the call cheap.
 *  Mirrors the harness's CLASSIFIER_MAX_PAIRS; deltas beyond the cap are kept
 *  unvalidated (fail-open) rather than dropped. */
export const VALIDATE_MAX_QUESTIONS = 20;

/** Render one proposed delta as the compact line the classifier judges. */
export function renderProposal(d: ProposedDelta): string {
  const delta = d.delta;
  switch (delta.op) {
    case "create":
      return `create ${delta.kind}: ${delta.content} (evidence: ${delta.evidence})`;
    case "update": {
      const fields = [
        ...(delta.content !== undefined ? [`content: ${delta.content}`] : []),
        ...(delta.evidence !== undefined ? [`evidence: ${delta.evidence}`] : []),
        ...(delta.importance !== undefined ? [`importance: ${delta.importance}`] : []),
        ...(delta.active !== undefined ? [`active: ${delta.active}`] : []),
        ...(delta.scope !== undefined ? [`scope: ${delta.scope}`] : []),
      ];
      return `update ${delta.id}: ${fields.join("; ")}`;
    }
    case "delete":
      return `delete ${delta.id}: ${delta.reason}`;
  }
}

/**
 * Build the batched per-delta grounding request for the validate mode: ONE bool
 * question per proposed delta ("d0", "d1", …) over the shared state (trajectory
 * evidence + rendered proposals). Pure — unit-testable.
 */
export function buildValidateQuestions(
  deltas: ProposedDelta[],
  evidence: string,
): { state: Record<string, unknown>; questions: Record<string, { instructions: string; trueCriteria: string; falseCriteria: string }> } {
  const proposals: Record<string, string> = {};
  deltas.forEach((d, i) => {
    proposals[`d${i}`] = renderProposal(d);
  });
  const questions: Record<string, { instructions: string; trueCriteria: string; falseCriteria: string }> = {};
  for (const key of Object.keys(proposals)) {
    questions[key] = {
      instructions:
        "You are validating proposed self-improvement deltas for a coding agent. Below is the trajectory evidence and one proposed change to the agent's harness state. Is this proposal concretely grounded in the evidence — no fabricated facts or ids, no unsupported claims?",
      trueCriteria: "The proposed delta is directly supported by the trajectory evidence.",
      falseCriteria: "The proposed delta is not grounded in the evidence (fabricated, speculative, or unsupported).",
    };
  }
  return { state: { trajectory: evidence, proposals }, questions };
}

/**
 * Apply validation answers: keep deltas the classifier confirmed (or did not
 * answer — fail-open) and drop the ones it explicitly rejected. Pure.
 */
export function filterValidated(
  deltas: ProposedDelta[],
  answers: Record<string, ClassifyBoolAnswer>,
): { kept: ProposedDelta[]; dropped: number } {
  const kept = deltas.filter((_, i) => answers[`d${i}`]?.value !== false);
  return { kept, dropped: deltas.length - kept.length };
}

/** Decide the validate outcome from a classify result. Errors keep everything
 *  (fail-open: the classifier can narrow, never block). */
export function validateDecision(
  deltas: ProposedDelta[],
  result: ClassifyBoolResult,
): { kept: ProposedDelta[]; dropped: number; because: string } {
  if (!result.ok) {
    return { kept: deltas, dropped: 0, because: `classifier error (${result.error ?? "unknown"}); keeping all deltas` };
  }
  const { kept, dropped } = filterValidated(deltas, result.answers);
  return { kept, dropped, because: dropped > 0 ? `classifier: ${dropped} ungrounded delta(s) dropped` : "classifier: all deltas grounded" };
}

/** Sum two optional usage records for merged telemetry (audited total spend). */
export function mergeUsage(
  a: { input: number; output: number } | undefined,
  b: { input: number; output: number } | undefined,
): { input: number; output: number } | undefined {
  if (!a) return b;
  if (!b) return a;
  return { input: a.input + b.input, output: a.output + b.output };
}
