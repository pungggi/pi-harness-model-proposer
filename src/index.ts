// pi-harness-model-proposer — dedicated-model proposer for pi-continual-harness.
//
// This is a companion extension: it registers ONE delta proposer (name "model")
// into pi-continual-harness's proposer registry. Select it with
// `/refine --proposer model` or `"proposer": "model"` in the harness config.
//
// THIN ENTRY (0.4.0, issue #5): pi loads extension entries sequentially and
// awaits every factory before startup continues, and it isolates each
// extension's module tree (a fresh, module-cache-disabled jiti per extension).
// Two consequences drove this design:
//
//   1. Perf — a static `import { registerProposer } from "pi-continual-harness"`
//      here would drag the ENTIRE harness module tree into pi startup
//      (~0.9s of jiti transpile on Windows, measured via the bogus-provider
//      fast-fail). This module therefore has ZERO runtime imports: the factory
//      synchronously pushes a LAZY delegate into the process-wide registry the
//      harness owns (`Symbol.for("pi-continual-harness.proposers")`, harness
//      ≥ 0.17.0). Cost: one Map.set. The real implementation
//      (proposer.ts → classify.ts, config.ts) is dynamic-imported on the first
//      actual propose() call, off the startup critical path.
//
//   2. Correctness — under the same isolation, a registerProposer call on ANY
//      module copy writes to a private registry /refine never reads (that was
//      true of the old static import too: registration was silently
//      invisible). The shared global is the seam the harness reads; see the
//      harness 0.17.0 changelog.
//
// Factory restrictions (pi docs: no processes, sockets, watchers, or timers in
// the factory) hold: this factory does one synchronous Map.set and nothing else.
//
// The public API re-export surface (createModelProposer, config, classify
// helpers) lives in ./api.ts — re-exports are static module-graph edges, so
// they must stay OUT of this entry to keep startup thin.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DeltaProposer, ProposeInput, ProposeResult } from "pi-continual-harness";

/** The harness's cross-instance proposer registry — public contract (harness ≥ 0.17.0). */
const REGISTRY_KEY = Symbol.for("pi-continual-harness.proposers");

type ProposerRegistry = Map<string, DeltaProposer>;

function sharedRegistry(): ProposerRegistry {
  const g = globalThis as Record<symbol, unknown>;
  let r = g[REGISTRY_KEY] as ProposerRegistry | undefined;
  if (!(r instanceof Map)) {
    r = new Map<string, DeltaProposer>();
    g[REGISTRY_KEY] = r;
  }
  return r;
}

export default function modelProposerExtension(_pi: ExtensionAPI): void {
  // Memoize the implementation promise so concurrent/repeated propose() calls
  // share ONE dynamic import (pi's loader isolation would otherwise re-evaluate
  // the module per import — harmless but wasteful, and this keeps the delegate
  // stable for the registry entry's lifetime).
  let impl: Promise<DeltaProposer> | undefined;
  const load = (): Promise<DeltaProposer> =>
    (impl ??= import("./proposer.js").then((m) => m.createModelProposer()));

  const lazy: DeltaProposer = {
    name: "model",
    propose: async (input: ProposeInput): Promise<ProposeResult> => (await load()).propose(input),
  };

  sharedRegistry().set("model", lazy);
}
