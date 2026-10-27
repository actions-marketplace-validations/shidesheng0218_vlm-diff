// Argument parsing for the vlm-diff CLI, split into its own module so it can
// be unit-tested (main.ts runs on import and can't be required in tests).

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

// Flags that take a value. Anything else is boolean — a boolean flag must
// never swallow the next token (a naive parser eats `--no-vlm before.png`'s
// `before.png`, silently producing "missing positional" errors).
const VALUE_FLAGS = new Set([
  "dom-before", "dom-after", "provider", "model", "threshold", "max-regions",
  "report", "out-dom", "out-png", "width", "height", "wait-ms", "approve",
  "ignore-rect", "url", "png", "diag", "out-diag", "selector", "property",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    // support --flag=value
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}
