import { isLevel } from './filter';
import {
  LIMITS,
  type JsonValue,
  type Level,
  type LogError,
  type LogMetadata,
  type LogOrigin,
  type LogRecord,
  type LogSource,
  type LogWire,
} from './types';

const encoder = new TextEncoder();
const marker = '[truncated]';
const redacted = '[redacted]';
const contentKeys =
  /^(?:text|content|prompt|prompts|messages|transcript|transcription|notetext|notebody|clipboard|clipboardtext|selectedtext|accessibility|accessibilitytree|audio|audiodata|audiobuffer|pcm|body|request|response|requestbody|responsebody|headers|stdout|stderr|raw|rawline|rawresponse|rawoutput)$/i;
const secretKeys =
  /token|password|passwd|secret|authorization|cookie|apikey|privatekey|credential/i;
const safeKey = (key: string) => key.replace(/[-_\s]/g, '');
const field = (value: unknown, key: string): unknown => {
  try {
    return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
  } catch {
    return undefined;
  }
};
const trim = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, Math.max(0, max - marker.length))}${marker}` : value;
export const byteLength = (value: string): number => encoder.encode(value).byteLength;

/** Defense in depth. Content-bearing call sites must still use safe summaries. */
export function sanitizeText(input: string, max: number = LIMITS.stringChars): string {
  return trim(
    input
      .slice(0, Math.max(max * 4, LIMITS.stackChars))
      .replace(
        /((?:\b(?:proxy-)?authorization|\b(?:set-)?cookie)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi,
        `$1${redacted}`
      )
      .replace(/\bBearer\s+[^\s,;"']+/gi, `Bearer ${redacted}`)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, redacted)
      .replace(/\b(?:sk|pk)[-_][A-Za-z0-9_-]{16,}\b/g, redacted)
      .replace(
        /((?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|password|secret|authorization)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
        `$1${redacted}`
      )
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@]+(?::[^\s/@]*)?@)/gi, `$1${redacted}@`)
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, `$1${redacted}`)
      .replace(/(?:\/Users\/|\/home\/)[^/\r\n:"'<>]+/g, '/[user]')
      .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\r\n:"'<>]+/gi, '[user]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]'),
    max
  );
}

interface Budget {
  nodes: number;
  seen: WeakSet<object>;
}
function json(value: unknown, depth: number, budget: Budget): JsonValue | undefined {
  if (++budget.nodes > 256 || depth > LIMITS.depth) return marker;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeText(value);
  if (typeof value !== 'object') return undefined;
  if (budget.seen.has(value)) return '[circular]';
  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (const entry of value.slice(
        0,
        value.length > LIMITS.arrayItems ? LIMITS.arrayItems - 1 : LIMITS.arrayItems
      )) {
        const item = json(entry, depth + 1, budget);
        if (item !== undefined) result.push(item);
      }
      if (value.length > LIMITS.arrayItems) result.push(marker);
      return result;
    }
    const result: Record<string, JsonValue> = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, keys.length > LIMITS.keys ? LIMITS.keys - 1 : LIMITS.keys)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const name = sanitizeText(key, 128);
      if (secretKeys.test(safeKey(key)) || contentKeys.test(safeKey(key))) {
        result[name] = redacted;
      } else {
        const item = json(field(value, key), depth + 1, budget);
        if (item !== undefined) result[name] = item;
      }
    }
    if (keys.length > LIMITS.keys) result._truncated = true;
    return result;
  } catch {
    return '[unavailable]';
  } finally {
    budget.seen.delete(value);
  }
}

const label = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value)
    ? sanitizeText(value, 128)
    : undefined;
function projectError(input: unknown, unexpected: boolean): LogError {
  const seen = new WeakSet<object>();
  const project = (value: unknown, depth: number): LogError => {
    if (depth >= LIMITS.causes) return { name: 'Error', message: marker, truncated: true };
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return { name: 'Error', message: '[circular]', truncated: true };
      seen.add(value);
    }
    const name = label(field(value, 'name')) ?? label(field(value, '_tag')) ?? 'Error';
    const tag = label(field(value, '_tag')) ?? label(field(value, 'tag'));
    const rawMessage = field(value, 'message');
    const message = unexpected
      ? 'Failure captured'
      : typeof rawMessage === 'string'
        ? sanitizeText(rawMessage)
        : typeof value === 'string'
          ? sanitizeText(value)
          : 'Non-Error failure';
    const rawStack = field(value, 'stack');
    const code = field(value, 'code');
    const reason = label(field(value, 'reason'));
    const cause = field(value, 'cause');
    const causes = field(value, 'errors') ?? field(value, 'causes');
    return {
      name,
      message,
      ...(field(value, 'truncated') === true ? { truncated: true as const } : {}),
      ...(tag ? { tag } : {}),
      ...(typeof rawStack === 'string'
        ? {
            stack: unexpected
              ? trim(
                  rawStack
                    .slice(0, 16_384)
                    .split('\n')
                    .slice(0, 80)
                    .flatMap(line => {
                      const frame = sourceFrame(line);
                      return frame ? [frame] : [];
                    })
                    .slice(0, 20)
                    .join('\n'),
                  LIMITS.stackChars
                )
              : sanitizeText(rawStack, LIMITS.stackChars),
          }
        : {}),
      ...(label(code)
        ? { code: label(code)! }
        : typeof code === 'number' && Number.isSafeInteger(code)
          ? { code }
          : {}),
      ...(reason ? { reason } : {}),
      ...(cause === undefined ? {} : { cause: project(cause, depth + 1) }),
      ...(Array.isArray(causes)
        ? {
            causes: causes.slice(0, LIMITS.causes).map(item => project(item, depth + 1)),
            ...(causes.length > LIMITS.causes ? { truncated: true as const } : {}),
          }
        : {}),
    };
  };
  try {
    return project(input, 0);
  } catch {
    return { name: 'Error', message: 'Unserializable failure' };
  }
}

export function sanitizeSourceLocation(input: string): string | undefined {
  let location = input.replaceAll('\\', '/').split(/[?#]/, 1)[0]!;
  const anchor = location.match(
    /(?:^|\/)(app\.asar(?:\.unpacked)?\/|\.vite\/|assets\/|src\/|node_modules\/)/
  );
  if (anchor?.index !== undefined) location = location.slice(anchor.index).replace(/^\//, '');
  else if (!location.startsWith('node:')) location = location.slice(location.lastIndexOf('/') + 1);
  if (location.length > 300 || !/^[a-zA-Z0-9_./@:+-]+$/.test(location)) return undefined;
  if (!location.startsWith('node:') && !/\.(?:[cm]?js|tsx?)$/.test(location)) return undefined;
  return location;
}

export function sourceFrame(line: string): string | undefined {
  // Keep source coordinates, not function labels, eval text, URL queries or the
  // arbitrary error-message lines which V8 places before its first frame.
  const match = line.match(/^\s*at (?:[^()\n]*\()?([^()\n]+):(\d{1,9}):(\d{1,9})\)?$/);
  if (!match) return undefined;
  const location = sanitizeSourceLocation(match[1]!);
  return location ? `    at ${location}:${match[2]}:${match[3]}` : undefined;
}

export const normalizeError = (input: unknown): LogError => projectError(input, false);

/** Unknown renderer failures must not retain messages or stack function labels. */
export const normalizeUnexpectedError = (input: unknown): LogError => projectError(input, true);

function fit<T extends LogWire>(record: T, limit: number): T {
  if (byteLength(JSON.stringify(record)) + 1 <= limit) return record;
  // Preserve the envelope and stable failure classification before detail.
  let result = {
    ...record,
    context: { _truncated: true },
    truncated: true as const,
  };
  if (byteLength(JSON.stringify(result)) + 1 <= limit) return result;
  if (result.error) {
    const { name, message, tag, code, reason } = result.error;
    result = {
      ...result,
      error: {
        name,
        message: trim(message, 256),
        tag,
        code,
        reason,
        truncated: true,
      },
    };
  }
  return { ...result, message: trim(result.message, 256) };
}

export function makeWire(
  level: Level,
  scope: string,
  message: string,
  metadata?: LogMetadata,
  timestamp = new Date().toISOString()
): LogWire {
  const context = json(field(metadata, 'context'), 0, {
    nodes: 0,
    seen: new WeakSet(),
  });
  const error = field(metadata, 'error');
  return fit(
    {
      schemaVersion: 1,
      timestamp,
      level,
      scope: sanitizeText(scope, LIMITS.scopeChars),
      message: sanitizeText(message),
      ...(context && typeof context === 'object' && !Array.isArray(context)
        ? { context: context as Record<string, JsonValue> }
        : {}),
      ...(error === undefined ? {} : { error: normalizeError(error) }),
    },
    LIMITS.recordBytes - 1024
  );
}

/** Normalize permitted wire fields only. Source and product identity are never read. */
export function parseWire(input: unknown): LogWire | undefined {
  const level = field(input, 'level'),
    scope = field(input, 'scope'),
    message = field(input, 'message'),
    timestamp = field(input, 'timestamp');
  if (
    field(input, 'schemaVersion') !== 1 ||
    !isLevel(level) ||
    typeof scope !== 'string' ||
    !scope.length ||
    scope.length > LIMITS.scopeChars ||
    typeof message !== 'string' ||
    typeof timestamp !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  )
    return undefined;
  const context = field(input, 'context');
  if (
    context !== undefined &&
    (context === null || typeof context !== 'object' || Array.isArray(context))
  )
    return undefined;
  const wire = makeWire(
    level,
    scope,
    message,
    {
      context: context as LogMetadata['context'],
      error: field(input, 'error'),
    },
    timestamp
  );
  return field(input, 'truncated') === true ? { ...wire, truncated: true } : wire;
}

export function makeRecord(wire: LogWire, origin: LogOrigin, source: LogSource): LogRecord {
  return fit(
    {
      ...wire,
      app: sanitizeText(origin.app, 128),
      appVersion: sanitizeText(origin.appVersion, 128),
      ...(origin.buildId ? { buildId: sanitizeText(origin.buildId, 128) } : {}),
      appRunId: sanitizeText(origin.appRunId, 128),
      runtime: source.runtime,
      pid: source.pid,
      ...(source.surface ? { surface: sanitizeText(source.surface, 128) } : {}),
    },
    LIMITS.recordBytes
  );
}

/** Validate retained records before export, then sanitize only the common envelope. */
export function parseRecord(input: unknown, expectedApp: string): LogRecord | undefined {
  const wire = parseWire(input);
  const app = field(input, 'app'),
    appVersion = field(input, 'appVersion'),
    appRunId = field(input, 'appRunId'),
    runtime = field(input, 'runtime'),
    pid = field(input, 'pid'),
    buildId = field(input, 'buildId'),
    surface = field(input, 'surface');
  if (
    !wire ||
    app !== expectedApp ||
    typeof appVersion !== 'string' ||
    typeof appRunId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(appRunId) ||
    (runtime !== 'main' &&
      runtime !== 'renderer' &&
      runtime !== 'worker' &&
      runtime !== 'native') ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid < 0
  )
    return undefined;
  return makeRecord(
    wire,
    {
      app,
      appVersion,
      appRunId,
      ...(typeof buildId === 'string' ? { buildId } : {}),
    },
    {
      runtime,
      pid,
      ...(typeof surface === 'string' ? { surface } : {}),
    }
  );
}

export const formatJsonLine = (record: LogRecord): string => `${JSON.stringify(record)}\n`;
export function formatConsole(record: LogWire): string {
  return `${record.timestamp} ${record.level.toUpperCase()} [${record.scope}] ${record.message}${record.context ? ` ${JSON.stringify(record.context)}` : ''}${record.error ? ` ${JSON.stringify(record.error)}` : ''}`;
}
