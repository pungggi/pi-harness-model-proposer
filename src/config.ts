// User configuration for the model proposer: ~/.pi/agent/harness-model.json
//
// The model proposer is the dedicated-model alternate for pi-continual-harness's
// /refine. It is selected via `proposer: "model"` in the harness config or
// `/refine --proposer model`. This file holds only the knobs that are specific
// to the model call (which model, token budget, delta cap, classifier use);
// everything else (durable scope, cadence, outcome loop, classifier model)
// stays in the harness config.
//
// Robust by design: missing or malformed file → {} (all defaults), never throws.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelProposerConfig {
  /** Model id ("provider/id" or bare) for the proposal completion. When unset,
   *  the proposer uses the active session model (the harness default). */
  model?: string;
  /** Max output tokens for the proposal completion. */
  maxOutputTokens?: number;
  /** Cap on deltas applied per run (bounds spend; excess is dropped). */
  maxDeltas?: number;
  /** Opt-in classifier gate (harness 0.12+ `classify` seam): ask ONE cheap
   *  yes/no question over the trajectory before the dedicated-model completion
   *  and skip the call entirely when the answer is "no durable correction".
   *  Requires `classifier.model` in harness.json; no-op (degrades) otherwise. */
  gate?: boolean;
  /** Opt-in classifier validation: after the completion, have the classifier
   *  confirm each proposed delta is grounded in the evidence; drop the ones it
   *  rejects. Requires `classifier.model` in harness.json; no-op otherwise. */
  validate?: boolean;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_MAX_DELTAS = 20;
export const CONFIG_PATH = join(homedir(), ".pi", "agent", "harness-model.json");

/** Load and validate the config. Tolerant: missing/malformed → {} (defaults). */
export async function loadConfig(path: string = CONFIG_PATH): Promise<ModelProposerConfig> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<ModelProposerConfig>;
    return {
      ...(typeof parsed.model === "string" && parsed.model.length > 0 ? { model: parsed.model } : {}),
      ...(typeof parsed.maxOutputTokens === "number" && Number.isFinite(parsed.maxOutputTokens) && parsed.maxOutputTokens > 0
        ? { maxOutputTokens: parsed.maxOutputTokens }
        : {}),
      ...(typeof parsed.maxDeltas === "number" && Number.isFinite(parsed.maxDeltas) && parsed.maxDeltas > 0
        ? { maxDeltas: parsed.maxDeltas }
        : {}),
      ...(typeof parsed.gate === "boolean" ? { gate: parsed.gate } : {}),
      ...(typeof parsed.validate === "boolean" ? { validate: parsed.validate } : {}),
    };
  } catch {
    return {};
  }
}
