import { test } from "node:test";
import assert from "node:assert/strict";
import { createCliProvider } from "./provider.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("cli provider: VLM_DIFF_CLASSIFY_MODEL takes effect on the CLI path (cheap tier)", () => {
  withEnv({ ANTHROPIC_API_KEY: "test-key", VLM_DIFF_CLASSIFY_MODEL: "claude-haiku-4.5" }, () => {
    const p = createCliProvider({ provider: "anthropic" });
    assert.equal(p.model, "claude-haiku-4.5");
  });
});

test("cli provider: without VLM_DIFF_CLASSIFY_MODEL the CLI gets the default model", () => {
  withEnv({ ANTHROPIC_API_KEY: "test-key", VLM_DIFF_CLASSIFY_MODEL: undefined }, () => {
    const p = createCliProvider({ provider: "anthropic" });
    assert.equal(p.model, "claude-sonnet-5");
  });
});
