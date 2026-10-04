// Content-addressed cache key: identical crop pixels + identical prompt +
// identical model classify to the same result, so hashing those inputs is
// sufficient and requires no extra bookkeeping.
//
// v0.2: the key now includes the model context and a version prefix. The
// v0.1 key hashed only pixels + hint, so switching models with a warm cache
// silently returned another model's classifications. The prefix also
// invalidates every v0.1 entry automatically.
//
// v0.9: PROMPT_VERSION joins the hash. The system prompt, hint sentences and
// response normalization (vlm-classify.ts) used to be invisible to the key,
// so a prompt edit kept serving stale conclusions for up to the 7-day TTL.
// RULE: bump PROMPT_VERSION whenever SYSTEM_PROMPT, hintSentence or
// parseClassification change. (An explicit constant, not a hash of the prompt
// text, so a typo fix doesn't silently invalidate every entry — the bump is a
// deliberate act.)

import { createHash } from "node:crypto";

export const CACHE_KEY_VERSION = "v2";
/** Bump on any change to the classification prompt or response parsing. */
export const PROMPT_VERSION = "p1";

export function computeCacheKey(
  beforeCrop: Buffer,
  afterCrop: Buffer,
  promptContext?: string,
  /** e.g. "dashscope/kimi/kimi-k3" — same pixels + different model = different classification */
  modelContext?: string,
  /** defaults to PROMPT_VERSION; overridable for tests and migrations */
  promptVersion: string = PROMPT_VERSION,
): string {
  const hash = createHash("sha256").update(beforeCrop).update(afterCrop);
  // Prompt-affecting context (e.g. DOM-field hints) must be part of the key:
  // same pixels + different hint can yield a different classification.
  if (promptContext) hash.update(promptContext);
  if (modelContext) hash.update(`\u0000model:${modelContext}`);
  hash.update(`\u0000prompt:${promptVersion}`);
  return `${CACHE_KEY_VERSION}-${hash.digest("hex")}`;
}
