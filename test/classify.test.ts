// Classifier seam tests (harness 0.12+): the opt-in gate (pre-filter that skips
// the dedicated-model completion) and validate (post-filter that drops
// ungrounded deltas), their pure builders, and the fail-open contract —
// `classify` undefined or erroring must degrade to today's behavior, never
// block. All fakes; no real classifier or model call.

import { describe, it, expect } from "vitest";
import type { ClassifyBoolResult, ClassifyFn, HarnessItem, HarnessState, ProposeInput } from "pi-continual-harness";
import type { ModelProposerConfig } from "../src/config.js";
import { createModelProposer } from "../src/proposer.js";
import {
  buildValidateQuestions,
  filterValidated,
  mergeUsage,
  renderProposal,
  validateDecision,
  VALIDATE_MAX_QUESTIONS,
} from "../src/classify.js";

function item(over: Partial<HarnessItem> & Pick<HarnessItem, "id" | "kind" | "content">): HarnessItem {
  const now = 10_000;
  return { evidence: "e", importance: 0.5, active: true, ownerModel: "", createdAt: now, updatedAt: now, ...over };
}

const state = (items: HarnessItem[]): HarnessState => ({ items });

const MODEL_OUTPUT = JSON.stringify([
  { op: "create", kind: "memory", content: "use postgres", evidence: "decided in review" },
  { op: "create", kind: "memory", content: "fabricated fact", evidence: "not in the trajectory" },
]);

interface ClassifyHarness {
  classify: ClassifyFn;
  /** Requests the fake classify saw, for asserting question shape/order. */
  requests: Array<{ state: Record<string, unknown>; questions: Record<string, { instructions: string; trueCriteria: string; falseCriteria: string }> }>;
}

/** Fake classify answering per-question from a map; missing keys → no answer. */
function fakeClassify(
  answers: Record<string, { value: boolean; confidence?: number }>,
  usage?: { input: number; output: number },
): ClassifyHarness {
  const requests: ClassifyHarness["requests"] = [];
  return {
    requests,
    classify: async (req) => {
      requests.push(req);
      const parsed: Record<string, { value: boolean; confidence?: number }> = {};
      for (const key of Object.keys(req.questions)) {
        if (answers[key]) parsed[key] = answers[key];
      }
      return { ok: true, answers: parsed, model: "typesafe/jev-test", ...(usage ? { usage } : {}) } satisfies ClassifyBoolResult;
    },
  };
}

function fakeComplete(text: string, usage?: { input: number; output: number }): NonNullable<ProposeInput["complete"]> {
  return async () => ({ text, ...(usage ? { usage } : {}) });
}

const cfg = (over: Record<string, unknown> = {}): ModelProposerConfig => over as unknown as ModelProposerConfig;

async function propose(opts: {
  config?: Record<string, unknown>;
  classify?: ClassifyFn;
  complete?: ProposeInput["complete"];
  items?: HarnessItem[];
}) {
  const proposer = createModelProposer({ getConfig: async () => cfg(opts.config) });
  return proposer.propose({
    evidence: "[user] we settled on postgres for the audit service",
    state: state(opts.items ?? []),
    lookback: 10,
    complete: opts.complete ?? fakeComplete(MODEL_OUTPUT, { input: 42, output: 7 }),
    ...(opts.classify ? { classify: opts.classify } : {}),
  });
}

describe("gate (pre-filter, opt-in)", () => {
  it("skips the model call entirely when the classifier says no durable correction", async () => {
    let completeCalls = 0;
    const { classify, requests } = fakeClassify({ gate: { value: false, confidence: 0.91 } }, { input: 11, output: 1 });
    const r = await propose({
      config: { gate: true },
      classify,
      complete: async () => {
        completeCalls++;
        return { text: "[]" };
      },
    });
    expect(completeCalls).toBe(0);
    expect(r.deltas ?? []).toHaveLength(0);
    // the classifier call is the ONLY spend → audited as the modelCall
    expect(r.modelCall?.ok).toBe(true);
    expect(r.modelCall?.model).toBe("typesafe/jev-test");
    expect(r.modelCall?.inputTokens).toBe(11);
    expect(r.modelCall?.outputTokens).toBe(1);
    // ONE bool question, over the trajectory — same shape as the harness gate
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions)).toEqual(["gate"]);
    expect(requests[0]!.state.trajectory).toContain("postgres");
  });

  it("proceeds to the completion when the gate passes; classifier usage is folded into the totals", async () => {
    const { classify } = fakeClassify({ gate: { value: true } }, { input: 11, output: 1 });
    const r = await propose({ config: { gate: true }, classify });
    expect(r.deltas).toHaveLength(2);
    expect(r.modelCall?.ok).toBe(true);
    expect(r.modelCall?.model).toBe("active");
    // completion (42/7) + classifier read (11/1) = merged audited spend
    expect(r.modelCall?.inputTokens).toBe(53);
    expect(r.modelCall?.outputTokens).toBe(8);
  });

  it("fails OPEN on a classifier error: the completion still runs", async () => {
    const classify: ClassifyFn = async () => ({ ok: false, answers: {}, model: "typesafe/jev-test", error: "boom" });
    let completeCalls = 0;
    const r = await propose({
      config: { gate: true },
      classify,
      complete: async () => {
        completeCalls++;
        return { text: MODEL_OUTPUT, usage: { input: 5, output: 5 } };
      },
    });
    expect(completeCalls).toBe(1);
    expect(r.deltas).toHaveLength(2);
    expect(r.modelCall?.ok).toBe(true);
    // no usage reported by the failed classifier → only the completion's
    expect(r.modelCall?.inputTokens).toBe(5);
  });

  it("fails OPEN on a missing gate answer (only ask/yes/no keys answered)", async () => {
    const { classify } = fakeClassify({});
    const r = await propose({ config: { gate: true }, classify });
    expect(r.deltas).toHaveLength(2);
    expect(r.modelCall?.ok).toBe(true);
  });

  it("degrades to today's behavior when classify is not injected (no classifier configured)", async () => {
    let completeCalls = 0;
    const r = await propose({
      config: { gate: true },
      complete: async () => {
        completeCalls++;
        return { text: MODEL_OUTPUT, usage: { input: 42, output: 7 } };
      },
    });
    expect(completeCalls).toBe(1);
    expect(r.deltas).toHaveLength(2);
    expect(r.modelCall?.inputTokens).toBe(42);
  });

  it("does not gate when not opted in (default off)", async () => {
    const { classify, requests } = fakeClassify({ gate: { value: false } });
    const r = await propose({ classify });
    expect(requests).toHaveLength(0);
    expect(r.deltas).toHaveLength(2);
  });
});

describe("validate (post-filter, opt-in)", () => {
  it("keeps grounded deltas and drops the ones the classifier rejects", async () => {
    const { classify, requests } = fakeClassify({ d0: { value: true, confidence: 0.9 }, d1: { value: false, confidence: 0.8 } }, { input: 9, output: 2 });
    const r = await propose({ config: { validate: true }, classify });
    expect(r.deltas).toHaveLength(1);
    expect((r.deltas![0]!.delta as { content: string }).content).toBe("use postgres");
    // one question per proposed delta, grounded in the evidence + rendered proposals
    expect(Object.keys(requests[0]!.questions)).toEqual(["d0", "d1"]);
    expect((requests[0]!.state.proposals as Record<string, string>)["d0"]).toContain("create memory: use postgres");
    expect(requests[0]!.state.trajectory).toContain("postgres");
    // classifier spend folded into the completion totals
    expect(r.modelCall?.inputTokens).toBe(51);
    expect(r.modelCall?.outputTokens).toBe(9);
  });

  it("fails OPEN on a classifier error: all deltas are kept", async () => {
    const classify: ClassifyFn = async () => ({ ok: false, answers: {}, error: "503" });
    const r = await propose({ config: { validate: true }, classify });
    expect(r.deltas).toHaveLength(2);
    expect(r.modelCall?.ok).toBe(true);
  });

  it("fails OPEN on missing answers (unanswered deltas are kept)", async () => {
    const { classify } = fakeClassify({ d0: { value: true } }); // d1 unanswered
    const r = await propose({ config: { validate: true }, classify });
    expect(r.deltas).toHaveLength(2);
  });

  it("keeps an empty result untouched without a classify call", async () => {
    const { classify, requests } = fakeClassify({});
    const r = await propose({ config: { validate: true }, classify, complete: fakeComplete("[]") });
    expect(r.deltas ?? []).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(r.modelCall?.ok).toBe(true);
  });

  it("degrades when classify is not injected", async () => {
    const r = await propose({ config: { validate: true } });
    expect(r.deltas).toHaveLength(2);
  });

  it("gate + validate compose: skip wins before any completion spend", async () => {
    const { classify, requests } = fakeClassify({ gate: { value: false }, d0: { value: false }, d1: { value: false } });
    let completeCalls = 0;
    const r = await propose({
      config: { gate: true, validate: true },
      classify,
      complete: async () => {
        completeCalls++;
        return { text: MODEL_OUTPUT };
      },
    });
    expect(completeCalls).toBe(0);
    expect(r.deltas ?? []).toHaveLength(0);
    expect(requests).toHaveLength(1); // only the gate ran
    expect(r.modelCall?.model).toBe("typesafe/jev-test");
  });
});

describe("pure builders", () => {
  const deltas = [
    {
      delta: { op: "create" as const, kind: "memory" as const, content: "use postgres", evidence: "decided in review" },
      rationale: "r0",
    },
    {
      delta: { op: "update" as const, id: "h_1", importance: 0.9, scope: "project" as const },
      rationale: "r1",
    },
    {
      delta: { op: "delete" as const, id: "h_2", reason: "obsolete" },
      rationale: "r2",
    },
  ];

  it("renderProposal renders every op compactly", () => {
    expect(renderProposal(deltas[0]!)).toBe("create memory: use postgres (evidence: decided in review)");
    expect(renderProposal(deltas[1]!)).toBe("update h_1: importance: 0.9; scope: project");
    expect(renderProposal(deltas[2]!)).toBe("delete h_2: obsolete");
  });

  it("buildValidateQuestions keys questions to rendered proposals over the evidence", () => {
    const req = buildValidateQuestions(deltas, "the evidence");
    expect(Object.keys(req.questions)).toEqual(["d0", "d1", "d2"]);
    expect(req.questions.d0!.trueCriteria).toContain("directly supported");
    expect((req.state.proposals as Record<string, string>)["d2"]).toBe("delete h_2: obsolete");
    expect(req.state.trajectory).toBe("the evidence");
  });

  it("filterValidated keeps unanswered (fail-open) and drops only explicit false", () => {
    const { kept, dropped } = filterValidated(deltas, { d0: { value: true }, d2: { value: false } });
    expect(kept.map((d) => d.rationale)).toEqual(["r0", "r1"]);
    expect(dropped).toBe(1);
  });

  it("validateDecision fails open on !ok and reports why", () => {
    const err = validateDecision(deltas, { ok: false, answers: {}, error: "boom" });
    expect(err.kept).toHaveLength(3);
    expect(err.because).toContain("classifier error");
    const ok = validateDecision(deltas, { ok: true, answers: { d0: { value: false }, d1: { value: false }, d2: { value: false } } });
    expect(ok.kept).toHaveLength(0);
    expect(ok.dropped).toBe(3);
    expect(ok.because).toContain("3 ungrounded");
  });

  it("mergeUsage sums when both present, passes through when one is missing", () => {
    expect(mergeUsage({ input: 1, output: 2 }, { input: 3, output: 4 })).toEqual({ input: 4, output: 6 });
    expect(mergeUsage(undefined, { input: 3, output: 4 })).toEqual({ input: 3, output: 4 });
    expect(mergeUsage({ input: 1, output: 2 }, undefined)).toEqual({ input: 1, output: 2 });
    expect(mergeUsage(undefined, undefined)).toBeUndefined();
  });

  it("VALIDATE_MAX_QUESTIONS matches the harness pair cap (20)", () => {
    expect(VALIDATE_MAX_QUESTIONS).toBe(20);
  });
});
