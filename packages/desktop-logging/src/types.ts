import type { Effect } from "effect";

export const LIMITS = Object.freeze({
  recordBytes: 16 * 1024,
  lineBytes: 16 * 1024,
  depth: 5,
  causes: 3,
  keys: 32,
  arrayItems: 32,
  stringChars: 2048,
  stackChars: 4096,
  scopeChars: 128,
  queueRecords: 128,
  queueBytes: 1024 * 1024,
  filterChars: 1024,
  filterPatterns: 16,
});

export type Level = "debug" | "info" | "warn" | "error";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export interface LogMetadata {
  readonly context?: Readonly<Record<string, JsonValue | undefined>>;
  readonly error?: unknown;
}
export interface LogError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly tag?: string;
  readonly code?: string | number;
  readonly reason?: string;
  readonly cause?: LogError;
  readonly causes?: readonly LogError[];
  readonly truncated?: true;
}
export interface LogWire {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly level: Level;
  readonly scope: string;
  readonly message: string;
  readonly context?: Readonly<Record<string, JsonValue>>;
  readonly error?: LogError;
  readonly truncated?: true;
}
export interface LogOrigin {
  readonly app: string;
  readonly appVersion: string;
  readonly buildId?: string;
  readonly appRunId: string;
}
export interface LogSource {
  readonly runtime: "main" | "renderer" | "worker" | "native";
  readonly pid: number;
  readonly surface?: string;
}
export type TrustedSource = LogSource;
export interface LogRecord extends LogWire, LogOrigin, LogSource {}
export type ScopedLog = {
  readonly [K in Level]: (
    message: string,
    metadata?: LogMetadata,
  ) => Effect.Effect<void>;
};
export type SyncScopedLog = {
  readonly [K in Level]: (message: string, metadata?: LogMetadata) => void;
};
export interface MainLoggerService {
  readonly appRunId: string;
  readonly scoped: (scope: string) => ScopedLog;
  readonly scopedSync: (scope: string) => SyncScopedLog;
}
