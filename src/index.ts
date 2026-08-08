// pi-harness-model-proposer — dedicated-model proposer for pi-continual-harness.
//
// This is a companion extension: it registers ONE delta proposer (name "model")
// into pi-continual-harness's proposer registry. Select it with
// `/refine --proposer model` or `"proposer": "model"` in the harness config.
//
// It owns NO state and makes NO model calls of its own — it calls the one-shot
// `complete` closure the harness injects into ProposeInput (built from
// ctx.modelRegistry). All spend is recorded by the harness in the refine audit
// entry, so the call is hidden from the transcript but audited (model/tokens/
// latency), and every proposal still flows through the harness's audited,
// branchable applyDeltas.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProposer } from "pi-continual-harness";
import { createModelProposer } from "./proposer.js";

export default function modelProposerExtension(_pi: ExtensionAPI): void {
  registerProposer(createModelProposer());
}

export { createModelProposer, type CreateModelProposerOptions } from "./proposer.js";
export { loadConfig, type ModelProposerConfig, CONFIG_PATH, DEFAULT_MAX_DELTAS, DEFAULT_MAX_OUTPUT_TOKENS } from "./config.js";
