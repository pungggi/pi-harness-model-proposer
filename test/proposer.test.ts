// Unit tests for the dedicated-model proposer.
//
// The proposer is pure given an injected `complete`, so every test injects a
// fake that returns canned model output (or throws). No real model call. The
// focus is the parse/validate/sanitize boundary: the harness's applyDeltas is
// all-or-nothing and re-throws on unknown ids, so a single bad delta must never
// escape this proposer.

import { describe, it, expect } from "vitest";
import type { CompleteResult, HarnessItem, HarnessState, ProposeInput } from "pi-continual-harness";
import type { ModelProposerConfig } from "../src/config.js";
import {
  buildPrompt,
  createModelProposer,
  extractJsonArray,
  parseDeltas,
  sanitizeDelta,
} from "../src/proposer.js";

function item(over: Partial<HarnessItem> & Pick<HarnessItem, "id" | "kind" | "content">): HarnessItem {
  const now = 10_000;
  return { evidence: "e", importance: 0.5, active: true, ownerModel: "", createdAt: now, updatedAt: now, ...over };
}

const state = (items: HarnessItem[]): HarnessState => ({ items });

/** Fake `complete` returning a fixed text. */
function fakeComplete(text: string, usage?: { input: number; output: number }): NonNullable<ProposeInput["complete"]> {
  return async () => ({ text, ...(usage ? { usage } : {}) });
}

/** Fake `complete` that rejects. */
function throwingComplete(err: Error): NonNullable<ProposeInput["complete"]> {
  return async () => {
    throw err;
  };
}

const cfg = (over: Record<string, unknown> = {}): ModelProposerConfig => over as unknown as ModelProposerConfig;

function proposeWith(
  text: string,
  items: HarnessItem[] = [],
  over: Record<string, unknown> = {},
) {
  const proposer = createModelProposer({ getConfig: async () => cfg(over) });
  return proposer.propose({
    evidence: "[user] fix the login bug",
    state: state(items),
    lookback: 10,
    complete: fakeComplete(text, { input: 42, output: 7 }),
  });
}

describe("create/model deltas", () => {
  it("parses a valid create into a ProposedDelta with telemetry", async () => {
    const r = await proposeWith(
      JSON.stringify([{ op: "create", kind: "memory", content: "use postgres", evidence: "decided in review", importance: 0.8 }]),
    );
    expect(r.deltas).toHaveLength(1);
    const d = r.deltas![0]!;
    expect(d.delta).toMatchObject({ op: "create", kind: "memory", content: "use postgres", evidence: "decided in review", importance: 0.8 });
    expect(r.modelCall?.ok).toBe(true);
    expect(r.modelCall?.inputTokens).toBe(42);
    expect(r.modelCall?.outputTokens).toBe(7);
    expect(r.modelCall?.model).toBe("active");
  });

  it("applies update/delete only against ids that exist in state", async () => {
    const items = [item({ id: "h_real", kind: "prompt", content: "cite evidence" })];
    const r = await proposeWith(
      JSON.stringify([
        { op: "update", id: "h_real", importance: 0.9 },
        { op: "delete", id: "h_real", reason: "obsolete" },
        { op: "update", id: "h_madeup", content: "x" }, // unknown id → dropped
        { op: "delete", id: "h_madeup", reason: "x" }, // unknown id → dropped
      ]),
      items,
    );
    const ops = r.deltas!.map((d) => `${d.delta.op}:${"id" in d.delta ? d.delta.id : ""}`);
    expect(ops).toEqual(["update:h_real", "delete:h_real"]);
    expect(r.deltas).toHaveLength(2);
    expect(r.modelCall?.ok).toBe(true);
  });

  it("drops creates that lack evidence or content", async () => {
    const r = await proposeWith(
      JSON.stringify([
        { op: "create", kind: "memory", content: "no evidence" }, // no evidence → dropped
        { op: "create", kind: "memory", evidence: "e" }, // no content → dropped
        { op: "create", kind: "memory", content: "  ", evidence: "e" }, // blank content → dropped
        { op: "create", content: "x", evidence: "e" }, // bad kind → dropped
        { op: "create", kind: "prompt", content: "good", evidence: "saw it" }, // valid
      ]),
    );
    expect(r.deltas).toHaveLength(1);
    expect((r.deltas![0]!.delta as { content: string }).content).toBe("good");
  });

  it("drops an update that carries no settable field", async () => {
    const items = [item({ id: "h_x", kind: "prompt", content: "c" })];
    const r = await proposeWith(JSON.stringify([{ op: "update", id: "h_x" }]), items);
    expect(r.deltas ?? []).toHaveLength(0);
  });

  it("drops a later update/delete of an id deleted earlier in the same batch", async () => {
    // [delete h_x, update h_x]: the delete is valid, but the update references an
    // id that will be gone — drop it here so applyDeltas never throws on it.
    const items = [item({ id: "h_x", kind: "prompt", content: "c" })];
    const r = await proposeWith(
      JSON.stringify([
        { op: "delete", id: "h_x", reason: "obsolete" },
        { op: "update", id: "h_x", content: "changed" }, // dropped: deleted above
        { op: "delete", id: "h_x", reason: "again" }, // dropped: deleted above
      ]),
      items,
    );
    expect(r.deltas).toHaveLength(1);
    expect(r.deltas![0]!.delta.op).toBe("delete");
    expect(r.modelCall?.ok).toBe(true);
  });
});

describe("robustness / fallback", () => {
  it("returns ok:false when the model output is not valid JSON", async () => {
    const r = await proposeWith("the deltas are: create ...");
    expect(r.deltas ?? []).toHaveLength(0);
    expect(r.modelCall?.ok).toBe(false);
    expect(r.modelCall?.error).toMatch(/not valid JSON/);
  });

  it("returns ok:false when the model output is valid JSON but not an array", async () => {
    const r = await proposeWith(JSON.stringify({ op: "create", kind: "memory", content: "x", evidence: "e" }));
    expect(r.modelCall?.ok).toBe(false);
    expect(r.modelCall?.error).toMatch(/not a JSON array/);
  });

  it("treats an empty array as a valid no-op (ok:true)", async () => {
    const r = await proposeWith("[]");
    expect(r.deltas ?? []).toHaveLength(0);
    expect(r.modelCall?.ok).toBe(true);
  });

  it("records an audited failure when complete throws", async () => {
    const proposer = createModelProposer({ getConfig: async () => cfg() });
    const r = await proposer.propose({
      evidence: "e",
      state: state([]),
      lookback: 10,
      complete: throwingComplete(new Error("503 upstream")),
    });
    expect(r.deltas ?? []).toHaveLength(0);
    expect(r.modelCall?.ok).toBe(false);
    expect(r.modelCall?.error).toContain("503 upstream");
    expect(r.modelCall?.error).toContain("model call failed");
  });

  it("records an audited failure when complete is not injected (no model)", async () => {
    const proposer = createModelProposer({ getConfig: async () => cfg() });
    const r = await proposer.propose({ evidence: "e", state: state([]), lookback: 10 });
    expect(r.deltas ?? []).toHaveLength(0);
    expect(r.modelCall?.ok).toBe(false);
    expect(r.modelCall?.error).toMatch(/not injected/);
  });
});

describe("config + spend bounding", () => {
  it("caps the number of deltas at maxDeltas (excess dropped)", async () => {
    const arr = Array.from({ length: 6 }, (_, i) => ({ op: "create", kind: "memory", content: `c${i}`, evidence: `e${i}` }));
    const r = await proposeWith(JSON.stringify(arr), [], { maxDeltas: 2 });
    expect(r.deltas).toHaveLength(2);
  });

  it("passes config.model through as modelId and labels telemetry", async () => {
    let seenOpts: { modelId?: string; maxOutputTokens?: number } | undefined;
    const proposer = createModelProposer({ getConfig: async () => cfg({ model: "anthropic/claude-haiku", maxOutputTokens: 1234 }) });
    const r = await proposer.propose({
      evidence: "e",
      state: state([]),
      lookback: 5,
      complete: async (_prompt, opts) => {
        seenOpts = opts;
        return { text: "[]" };
      },
    });
    expect(seenOpts?.modelId).toBe("anthropic/claude-haiku");
    expect(seenOpts?.maxOutputTokens).toBe(1234);
    expect(r.modelCall?.model).toBe("anthropic/claude-haiku");
  });

  it("clamps model-provided importance into [0,1]", async () => {
    const r = await proposeWith(
      JSON.stringify([
        { op: "create", kind: "prompt", content: "high", evidence: "e", importance: 5 },
        { op: "create", kind: "prompt", content: "low", evidence: "e", importance: -3 },
      ]),
    );
    const imps = r.deltas!.map((d) => (d.delta as { importance?: number }).importance).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(imps).toEqual([0, 1]);
  });

  it("labels telemetry with the resolved model from complete (result.model)", async () => {
    const proposer = createModelProposer({ getConfig: async () => cfg() });
    const r = await proposer.propose({
      evidence: "e",
      state: state([]),
      lookback: 5,
      complete: async () => ({ text: "[]", model: "anthropic/claude-x" }),
    });
    expect(r.modelCall?.model).toBe("anthropic/claude-x");
  });
});

describe("pure helpers", () => {
  it("extractJsonArray strips code fences and prose", () => {
    expect(extractJsonArray("```json\n[{\"op\":\"create\"}]\n```")).toBe('[{"op":"create"}]');
    expect(extractJsonArray("here you go: []")).toBe("[]");
    expect(extractJsonArray("no array here")).toBe("no array here"); // unchanged → JSON.parse then fails downstream
  });

  it("parseDeltas returns ok:false on bad JSON, ok:true with dropped count on mixed input", () => {
    const input = { evidence: "e", state: state([]), lookback: 1 } as ProposeInput;
    const bad = parseDeltas("not json", 20, input);
    expect(bad.ok).toBe(false);
    const good = parseDeltas(
      JSON.stringify([
        { op: "create", kind: "memory", content: "ok", evidence: "e" },
        { op: "garbage" },
      ]),
      20,
      input,
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.deltas).toHaveLength(1);
      expect(good.dropped).toBe(1);
    }
  });

  it("sanitizeDelta returns null for non-objects and unknown ops", () => {
    const ids = new Set(["h_a"]);
    expect(sanitizeDelta(null, ids)).toBeNull();
    expect(sanitizeDelta("string", ids)).toBeNull();
    expect(sanitizeDelta({ op: "weird" }, ids)).toBeNull();
  });
});

describe("durable-layer scope (harness 0.9+)", () => {
  it("passes a whitelisted scope through on create", async () => {
    const r = await proposeWith(
      JSON.stringify([
        { op: "create", kind: "memory", content: "relay deploy uses piper", evidence: "e", scope: "project" },
        { op: "create", kind: "prompt", content: "cite evidence", evidence: "e", scope: "global" },
      ]),
    );
    expect(r.deltas).toHaveLength(2);
    expect(r.deltas![0]!.delta).toMatchObject({ scope: "project" });
    expect(r.deltas![1]!.delta).toMatchObject({ scope: "global" });
    // the slug itself is never taken from the model (stamped server-side)
    expect((r.deltas![0]!.delta as { project?: string }).project).toBeUndefined();
  });

  it("omits a garbage scope on create (defaults to global), doesn't drop the delta", async () => {
    const r = await proposeWith(
      JSON.stringify([{ op: "create", kind: "memory", content: "x", evidence: "e", scope: "everywhere" }]),
    );
    expect(r.deltas).toHaveLength(1);
    expect((r.deltas![0]!.delta as { scope?: string }).scope).toBeUndefined();
  });

  it("a scope-only update (id + scope) is a legitimate layer move", async () => {
    const items = [item({ id: "h_x", kind: "memory", content: "relay deploy" })];
    const r = await proposeWith(JSON.stringify([{ op: "update", id: "h_x", scope: "project" }]), items);
    expect(r.deltas).toHaveLength(1);
    expect(r.deltas![0]!.delta).toMatchObject({ op: "update", id: "h_x", scope: "project" });
    expect(r.deltas![0]!.rationale).toContain("scope → project");
  });

  it("an update with a garbage scope and nothing else settable is dropped", async () => {
    const items = [item({ id: "h_x", kind: "memory", content: "c" })];
    const r = await proposeWith(JSON.stringify([{ op: "update", id: "h_x", scope: "elsewhere" }]), items);
    expect(r.deltas ?? []).toHaveLength(0);
  });

  it("buildPrompt tags project-scoped items in the digest and documents the scope field", () => {
    const input = {
      evidence: "[user] do the thing",
      lookback: 10,
      state: state([
        item({ id: "h_g", kind: "memory", content: "global fact" }),
        item({ id: "h_p", kind: "memory", content: "project fact", scope: "project", project: "my-proj" }),
      ]),
    } as ProposeInput;
    const prompt = buildPrompt(input);
    expect(prompt).toContain("scope=project(my-proj)");
    expect(prompt).toContain("project fact");
    // globals stay untagged (scope=global would be noise on every line)
    expect(prompt).not.toContain("scope=global");
    // the schema + rules mention scope
    expect(prompt).toContain('"scope":"global|project"');
    expect(prompt).toMatch(/stamped server-side/);
  });
});
