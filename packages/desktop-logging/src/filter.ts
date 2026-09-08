import { LIMITS, type Level } from "./types";

export type Destination = "file" | "console";
export interface LogFilter {
  readonly issues: readonly string[];
  readonly enabled: (
    level: Level,
    scope: string,
    destination: Destination,
  ) => boolean;
}
const levels: readonly Level[] = ["debug", "info", "warn", "error"];
export const isLevel = (value: unknown): value is Level =>
  levels.includes(value as Level);

function supportedScopePattern(pattern: string): boolean {
  let inClass = false;
  let repetitions = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      const escaped = pattern[++index];
      if (!escaped || /[0-9k]/.test(escaped)) return false;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if ("(){}".includes(char)) return false;
    else if ("*+?".includes(char) && ++repetitions > 1) return false;
  }
  return !inClass;
}

/** Scope debug changes file admission in production, never console admission. */
export function makeFilter(config: {
  isDev: boolean;
  logLevel?: string;
  debugScopes?: string;
}): LogFilter {
  const issues: string[] = [];
  const override = isLevel(config.logLevel) ? config.logLevel : undefined;
  if (config.logLevel && !override)
    issues.push("Invalid LOG_LEVEL; using default thresholds");
  let patterns: RegExp[] = [];
  const raw = config.debugScopes?.trim() ?? "";
  if (raw) {
    try {
      const tokens = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (
        raw.length > LIMITS.filterChars ||
        tokens.length > LIMITS.filterPatterns
      )
        throw new Error();
      patterns = tokens.map((token) => {
        if (token.length > LIMITS.scopeChars) throw new Error();
        if (token.startsWith("/")) {
          if (!token.endsWith("/") || token.length < 3) throw new Error();
          const pattern = token.slice(1, -1);
          // A short regex can still backtrack excessively. Permit literals,
          // classes, anchors, alternation and at most one simple repetition.
          if (!supportedScopePattern(pattern)) throw new Error();
          return new RegExp(pattern, "i");
        }
        return new RegExp(
          `^${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i",
        );
      });
    } catch {
      patterns = [];
      issues.push("Invalid LOG_DEBUG_SCOPES; using default thresholds");
    }
  }
  return {
    issues,
    enabled(level, scope, destination) {
      if (!isLevel(level)) return false;
      if (override) return levels.indexOf(level) >= levels.indexOf(override);
      if (level === "debug") {
        if (destination === "console" && !config.isDev) return false;
        return patterns.length
          ? patterns.some((pattern) =>
              pattern.test(scope.slice(0, LIMITS.scopeChars)),
            )
          : config.isDev;
      }
      return destination === "file" || config.isDev || level !== "info";
    },
  };
}
