// Cache store abstraction for VLM classification results. The file-based
// implementation is the only backend today; the interface exists so a
// Redis/S3-backed store can be swapped in later without touching call sites.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Classification } from "../classify/vlm-classify.js";

export interface CacheEntry {
  classification: Classification;
  cachedAt: string;
  /** PROMPT_VERSION at write time, for auditing which prompt produced this entry */
  promptVersion?: string;
}

export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class FileCacheStore implements CacheStore {
  constructor(
    private readonly cacheDir: string,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  private pathFor(key: string): string {
    return join(this.cacheDir, `${key}.json`);
  }

  async get(key: string): Promise<CacheEntry | null> {
    try {
      const raw = await readFile(this.pathFor(key), "utf8");
      const entry: CacheEntry = JSON.parse(raw);
      const age = Date.now() - new Date(entry.cachedAt).getTime();
      if (age > this.ttlMs) return null;
      return entry;
    } catch (err: any) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(this.pathFor(key), JSON.stringify(entry, null, 2));
  }
}

/** In-memory store for tests — avoids touching the filesystem. */
export class MemoryCacheStore implements CacheStore {
  private map = new Map<string, CacheEntry>();

  async get(key: string): Promise<CacheEntry | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    this.map.set(key, entry);
  }
}
