/**
 * Structured front-end logging (ARCHITECTURE §4 counterpart to Rust's `tracing`).
 *
 * Rules:
 * - Development logs everything, production starts at `info`.
 * - Payloads are structured objects, never string concatenation.
 * - Never log book content, file paths outside the app data dir, API keys, or
 *   the full text of anything the user typed. Log identifiers and counts.
 */

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** `import.meta.env.DEV` is inlined by Vite, so the prod branch tree-shakes. */
const THRESHOLD: Level = import.meta.env.DEV ? "debug" : "info";

function emit(level: Level, scope: string, message: string, fields?: object): void {
  if (ORDER[level] < ORDER[THRESHOLD]) return;
  const payload = { scope, message, ...fields };
  const line = `[${level}] ${scope}: ${message}`;
  switch (level) {
    case "debug":
      console.debug(line, payload);
      return;
    case "info":
      console.info(line, payload);
      return;
    case "warn":
      console.warn(line, payload);
      return;
    case "error":
      console.error(line, payload);
      return;
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, fields?: object) => emit("debug", scope, message, fields),
    info: (message: string, fields?: object) => emit("info", scope, message, fields),
    warn: (message: string, fields?: object) => emit("warn", scope, message, fields),
    error: (message: string, fields?: object) => emit("error", scope, message, fields),
  };
}

/** Reshapes an unknown `throw` value into something safe to log or display. */
export function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  if (typeof error === "string") return { name: "Error", message: error };
  return { name: "Error", message: "未知错误" };
}
