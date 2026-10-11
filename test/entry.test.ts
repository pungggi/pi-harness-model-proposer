// Tests for the THIN extension entry (0.4.0, issue #5).
//
// The entry must stay thin: pi awaits every extension factory during startup,
// so any static runtime import here is paid by EVERY pi launch. The guard test
// enforces the invariant (only `import type` allowed); the others verify the
// synchronous registration into the process-wide registry the harness reads
// (harness ≥ 0.17.0) and the lazy delegation to the real proposer.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import factory from "../src/index.js";
import { listProposers } from "pi-continual-harness";
import type { DeltaProposer, HarnessItem, HarnessState, ProposeInput, ProposeResult } from "pi-continual-harness";

const KEY = Symbol.for("pi-continual-harness.proposers");

const shared = (): Map<string, DeltaProposer> => {
  const g = globalThis as Record<symbol, Map<string, DeltaProposer> | undefined>;
  return (g[KEY] ??= new Map());
};

const state = (items: HarnessItem[]): HarnessState => ({ items });

const minimalInput = (over: Partial<ProposeInput> = {}): ProposeInput => ({
  evidence: "did a thing",
  state: state([]),
  lookback: 10,
  ...over,
});

describe("thin entry guard", () => {
  it("src/index.ts has no static runtime imports (startup-cost invariant)", () => {
    const src = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    const meaningful = src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"))
      .filter((l) => l.startsWith("import ") || /^export\b.*\bfrom\b/.test(l));
    expect(meaningful.length).toBeGreaterThan(0); // sanity: we did strip comments
    for (const line of meaningful) {
      expect(line).toMatch(/^import\s+type\s/); // ONLY type imports survive
    }
  });
});

describe("modelProposerExtension factory", () => {
  it("synchronously registers a lazy 'model' proposer into the shared global registry", () => {
    factory({} as never);
    const p = shared().get("model");
    expect(p).toBeDefined();
    expect(p?.name).toBe("model");
  });

  it("is visible through the harness's own registry reads (cross-instance seam)", () => {
    factory({} as never);
    expect(listProposers()).toContain("model");
  });

  it("re-running the factory replaces the delegate (extension reload)", () => {
    factory({} as never);
    const first = shared().get("model");
    factory({} as never);
    const second = shared().get("model");
    expect(second).toBeDefined();
    expect(second).not.toBe(first); // fresh lazy delegate from the new module copy
  });

  it("the lazy delegate dynamic-imports the real proposer on first propose()", async () => {
    factory({} as never);
    const p = shared().get("model");
    expect(p).toBeDefined();
    // No `complete` injected → the real proposer's audited no-op path.
    const result: ProposeResult = await p!.propose(minimalInput());
    expect(result.deltas).toEqual([]);
    expect(result.modelCall?.ok).toBe(false);
  });

  it("the lazy delegate returns real deltas once complete is injected", async () => {
    factory({} as never);
    const p = shared().get("model");
    expect(p).toBeDefined();
    const result = await p!.propose(
      minimalInput({
        complete: async () => ({
          text: '[{"op":"create","kind":"memory","content":"prefer tabs here","evidence":"fixed formatting twice"}]',
        }),
      }),
    );
    expect(result.deltas ?? []).toHaveLength(1);
    expect(result.deltas?.[0]?.delta.op).toBe("create");
    expect(result.modelCall?.ok).toBe(true);
  });
});
