// Config loader tests: tolerant parsing, defaults, validation.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_DELTAS, DEFAULT_MAX_OUTPUT_TOKENS, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-harness-model-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns {} (defaults) when the file is missing", async () => {
    const cfg = await loadConfig(join(dir, "nope.json"));
    expect(cfg).toEqual({});
  });

  it("returns {} when the file is malformed JSON", async () => {
    const file = join(dir, "harness-model.json");
    writeFileSync(file, "{ not json");
    expect(await loadConfig(file)).toEqual({});
  });

  it("parses valid knobs", async () => {
    const file = join(dir, "harness-model.json");
    writeFileSync(file, JSON.stringify({ model: "anthropic/claude-haiku", maxOutputTokens: 2048, maxDeltas: 5 }));
    expect(await loadConfig(file)).toEqual({ model: "anthropic/claude-haiku", maxOutputTokens: 2048, maxDeltas: 5 });
  });

  it("drops invalid value types (non-string model, non-positive numbers)", async () => {
    const file = join(dir, "harness-model.json");
    writeFileSync(file, JSON.stringify({ model: 123, maxOutputTokens: -5, maxDeltas: 0 }));
    expect(await loadConfig(file)).toEqual({});
  });

  it("ignores unknown keys", async () => {
    const file = join(dir, "harness-model.json");
    writeFileSync(file, JSON.stringify({ model: "x", unrelated: true }));
    expect(await loadConfig(file)).toEqual({ model: "x" });
  });
});

describe("defaults", () => {
  it("exports sane defaults", () => {
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_DELTAS).toBeGreaterThan(0);
  });
});
