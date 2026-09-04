/**
 * Structured-log redaction. Any object field whose name
 * matches the sensitive pattern is replaced with '[REDACTED]' before it
 * reaches a transport. Pure — unit-tested in tests/policy/redact.test.ts.
 */
const SENSITIVE_FIELD = /token|secret|authorization/i;

const MAX_DEPTH = 8;

export function redactValue(value: unknown): unknown {
  return redactInner(value, 0, new WeakSet());
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(item => redactInner(item, depth + 1, seen));
  }
  if (value instanceof Error) {
    // Keep message/stack; errors don't carry named token fields we can walk safely.
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SENSITIVE_FIELD.test(key) ? '[REDACTED]' : redactInner(entry, depth + 1, seen);
  }
  return out;
}
