import { Context, type Effect } from 'effect';
import type { LogSource } from '@desktop/logging';
import type { RendererLoggingConfig } from '@prismical/desktop-contracts';
import type { ApplicationTFunction } from '@prismical/app-i18n';

export type { MainLoggerService, ScopedLog, SyncScopedLog, LogMetadata } from '@desktop/logging';
export { MainLogger } from '@desktop/logging';

/** Main-process transport boundary. Application logging uses MainLogger. */
export interface LoggingTransportService {
  readonly ingest: (input: unknown, source: LogSource) => boolean;
  readonly rendererConfig: Omit<RendererLoggingConfig, 'pid' | 'surface'>;
  readonly exportBundle: (t: ApplicationTFunction) => Effect.Effect<void, unknown>;
}
export class LoggingTransport extends Context.Tag('desktop/LoggingTransport')<
  LoggingTransport,
  LoggingTransportService
>() {}
