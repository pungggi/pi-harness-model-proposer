// Public API surface for hosts and tests. The pi extension entry is
// ./index.js (thin: zero runtime imports, synchronous global registration);
// re-exports are static module-graph edges, so they live HERE instead —
// `import { … } from "pi-harness-model-proposer"` keeps returning the same
// surface the old single-module entry exported, without dragging the proposer
// implementation into pi startup.

export { default } from "./index.js";
export { createModelProposer, type CreateModelProposerOptions } from "./proposer.js";
export { loadConfig, type ModelProposerConfig, CONFIG_PATH, DEFAULT_MAX_DELTAS, DEFAULT_MAX_OUTPUT_TOKENS } from "./config.js";
// Classifier seam (harness 0.12+): the gate/validate builders re-exported so
// hosts and tests can reuse them without reaching into internal paths.
export {
  buildGateRequest,
  buildValidateQuestions,
  filterValidated,
  gateDecision,
  mergeUsage,
  renderProposal,
  validateDecision,
  VALIDATE_MAX_QUESTIONS,
} from "./classify.js";
