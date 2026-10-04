// InstrumentedProvider: a transparent wrapper that turns "the model is a
// black box" into "every call is logged, capped, and budget-guarded".
//
// - logs every send() to an append-only JSONL cost log (src/cost/log.ts)
// - enforces an optional session budget (VLM_DIFF_BUDGET_USD): once the
//   accumulated estimated spend crosses it, further calls fail fast instead
//   of silently running up a bill
// - passes SendOpts (fn label, maxTokens) through to the inner provider

import type { Msg, Provider, SendOpts, TurnResult } from "./types.js";
import { estimateGateCostUsd } from "../cost/pricing.js";
import { appendCostLog } from "../cost/log.js";

/** Rough per-image vision token cost used for pre-call budget reservations. */
const IMAGE_TOKEN_ESTIMATE = 1500;

/**
 * Pre-call cost estimate used for budget reservations. Input tokens aren't
 * known until the response comes back, so estimate: ~4 chars/token for the
 * system prompt and text blocks, a fixed tile cost per image, and the
 * caller's maxTokens cap for output. This is an estimate, not a ceiling — a
 * call whose real usage exceeds it settles post-hoc against the budget.
 * Exported for tests.
 */
export function estimateCallCostUsd(model: string, system: string, messages: Msg[], opts?: SendOpts): number {
  let inputTokens = Math.ceil(system.length / 4);
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === "text") inputTokens += Math.ceil(block.text.length / 4);
      else inputTokens += IMAGE_TOKEN_ESTIMATE;
    }
  }
  return estimateGateCostUsd(model, { inputTokens, outputTokens: opts?.maxTokens ?? 1024 });
}

export class InstrumentedProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private spentUsd = 0;
  private reservedUsd = 0;

  constructor(
    private readonly inner: Provider,
    private readonly opts: { logPath?: string; budgetUsd?: number } = {},
  ) {
    this.name = inner.name;
    this.model = inner.model;
  }

  /** estimated USD spent through this wrapper so far (session-scoped) */
  get sessionSpendUsd(): number {
    return this.spentUsd;
  }

  private budgetUsd(): number | undefined {
    if (this.opts.budgetUsd !== undefined) return this.opts.budgetUsd;
    const raw = process.env.VLM_DIFF_BUDGET_USD;
    return raw !== undefined && raw !== "" ? Number(raw) : undefined;
  }

  async send(system: string, messages: Msg[], opts?: SendOpts): Promise<TurnResult> {
    const budget = this.budgetUsd();
    // Reserve an estimate BEFORE the call: in-flight concurrent calls count
    // against the budget, so N parallel sends can't all pass the gate and
    // overspend. Settled against the real cost on success, released on
    // failure — exactly once per call.
    const reservation = estimateCallCostUsd(this.model, system, messages, opts);
    if (budget !== undefined && this.spentUsd + this.reservedUsd + reservation > budget) {
      throw new Error(
        `Budget exceeded: $${this.spentUsd.toFixed(4)} already spent (plus $${this.reservedUsd.toFixed(4)} in flight) of the $${budget} budget (VLM_DIFF_BUDGET_USD). ` +
          `Raise the budget or rerun fewer pairs.`,
      );
    }

    const t0 = Date.now();
    const fn = opts?.fn ?? "send";
    this.reservedUsd += reservation;
    let result: TurnResult;
    try {
      result = await this.inner.send(system, messages, opts);
    } catch (err) {
      this.reservedUsd -= reservation;
      await appendCostLog(
        {
          ts: new Date().toISOString(),
          fn,
          provider: this.name,
          model: this.model,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - t0,
          costUsd: 0,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        this.opts.logPath,
      );
      throw err;
    }
    // success: settle the reservation exactly once, then bill the real cost
    this.reservedUsd -= reservation;
    const costUsd = estimateGateCostUsd(this.model, result.usage);
    this.spentUsd += costUsd;
    await appendCostLog(
      {
        ts: new Date().toISOString(),
        fn,
        provider: this.name,
        model: this.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        latencyMs: Date.now() - t0,
        costUsd,
        ok: true,
      },
      this.opts.logPath,
    );
    return result;
  }
}
