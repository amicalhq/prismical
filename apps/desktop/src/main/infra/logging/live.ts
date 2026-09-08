import { app, dialog } from 'electron';
import electronLog from 'electron-log';
import { randomUUID } from 'node:crypto';
import { release } from 'node:os';
import { openSync, closeSync, fstatSync, readSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect, Layer } from 'effect';
import {
  makeFilter,
  makeLogger,
  formatJsonLine,
  formatConsole,
  parseRecord,
  LIMITS,
  type LogRecord,
} from '@desktop/logging';
import { MainLogger, LoggingTransport } from './service';

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const resolveLogPaths = (
  userDataDir: string,
  options: { isDev?: boolean; isE2E?: boolean } = {}
) => {
  const name = options.isDev && !options.isE2E ? 'main-dev' : 'main';
  return {
    current: path.join(userDataDir, 'logs', `${name}.jsonl`),
    backup: path.join(userDataDir, 'logs', `${name}.old.jsonl`),
    legacy: path.join(userDataDir, 'logs', 'main.log'),
  };
};

/** Both snapshots are read synchronously on the main thread, so rotation cannot
 * run between them. Legacy text logs are explicitly excluded. */
export function snapshotLogs(paths: ReturnType<typeof resolveLogPaths>) {
  const notices = new Set<string>();
  const runs = new Set<string>();
  const files: { name: string; content: string }[] = [];
  for (const file of [paths.current, paths.backup]) {
    if (!existsSync(file)) {
      notices.add(`${path.basename(file)} is missing`);
      continue;
    }
    const fd = openSync(file, 'r');
    let content: string;
    try {
      const size = fstatSync(fd).size;
      const limit = LOG_MAX_BYTES + LIMITS.recordBytes;
      const buffer = Buffer.alloc(Math.min(size, limit));
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, read).toString('utf8');
      if (size > limit)
        notices.add(`${path.basename(file)}: snapshot truncated at retained-size budget`);
    } finally {
      closeSync(fd);
    }
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    else {
      lines.pop();
      notices.add(`${path.basename(file)}: incomplete final line excluded`);
    }
    const accepted: string[] = [];
    for (const line of lines) {
      try {
        if (Buffer.byteLength(line) > LIMITS.recordBytes) throw new Error();
        const record = parseRecord(JSON.parse(line), 'prismical');
        if (!record) throw new Error();
        if (runs.size < 128) runs.add(record.appRunId);
        else if (!runs.has(record.appRunId)) notices.add('Run ID list truncated');
        accepted.push(formatJsonLine(record).trimEnd());
      } catch {
        notices.add(`${path.basename(file)}: invalid record excluded`);
      }
    }
    files.push({
      name: path.basename(file),
      content: accepted.length ? `${accepted.join('\n')}\n` : '',
    });
  }
  if (existsSync(paths.legacy))
    notices.add('Legacy text logs excluded because they predate the diagnostic privacy contract');
  return { files, appRunIds: [...runs], notices: [...notices] };
}

/** Acquired before the larger application graph; it has no DB/auth/window dependencies. */
export function makeMainLogging(appRunId: string = randomUUID()) {
  const paths = resolveLogPaths(app.getPath('userData'), {
    isDev: !app.isPackaged,
    isE2E: process.env.PRISMICAL_E2E === '1',
  });
  const buildId =
    typeof __PRISMICAL_BUILD_ID__ === 'string' && __PRISMICAL_BUILD_ID__
      ? __PRISMICAL_BUILD_ID__
      : undefined;
  const origin = {
    app: 'prismical',
    appVersion: app.getVersion(),
    appRunId,
    ...(buildId ? { buildId } : {}),
  };
  const rendererConfig = {
    appVersion: origin.appVersion,
    appRunId: origin.appRunId,
    ...(buildId ? { buildId } : {}),
    isDev: !app.isPackaged,
    ...(process.env.LOG_LEVEL ? { logLevel: process.env.LOG_LEVEL } : {}),
    ...(process.env.LOG_DEBUG_SCOPES ? { debugScopes: process.env.LOG_DEBUG_SCOPES } : {}),
  };
  const filter = makeFilter(rendererConfig);
  const raw = electronLog.create({ logId: `diagnostics-${origin.appRunId}` });
  raw.transports.file.resolvePathFn = () => paths.current;
  raw.transports.file.maxSize = LOG_MAX_BYTES;
  raw.transports.file.sync = true;
  raw.transports.file.format = ({ data }) => [formatJsonLine(data[0] as LogRecord).trimEnd()];
  // electron-log sends its own file failures directly to this transport. Never
  // expose its unsanitized filesystem error or recursively use the failed file.
  raw.transports.console.format = ({ data }) => [
    data[0]?.schemaVersion === 1
      ? formatConsole(data[0] as LogRecord)
      : 'Diagnostic file write failed',
  ];
  const logger = makeLogger(
    (record, destinations) => {
      raw.transports.file.level = destinations.file ? 'debug' : false;
      raw.transports.console.level = destinations.console ? 'debug' : false;
      raw[record.level](record);
    },
    { origin, source: { runtime: 'main', pid: process.pid }, filter }
  );
  const exportBundle = Effect.tryPromise(async () => {
    const snapshot = snapshotLogs(paths);
    const bundle = {
      manifest: {
        schemaVersion: 1,
        app: origin.app,
        appVersion: origin.appVersion,
        ...(buildId ? { buildId } : {}),
        platform: process.platform,
        osRelease: release(),
        arch: process.arch,
        exportedAt: new Date().toISOString(),
        appRunIds: snapshot.appRunIds,
        notices: snapshot.notices,
      },
      files: snapshot.files,
    };
    const result = await dialog.showSaveDialog({
      title: 'Save diagnostic logs',
      defaultPath: `prismical-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Diagnostic bundle', extensions: ['json'] }],
    });
    if (!result.canceled && result.filePath)
      await writeFile(result.filePath, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  });
  const transport = {
    ingest: logger.ingest,
    rendererConfig,
    exportBundle: exportBundle.pipe(
      Effect.tapError(() =>
        Effect.sync(() =>
          dialog.showErrorBox(
            'Log export failed',
            'The diagnostic bundle could not be saved. Please try another location.'
          )
        )
      )
    ),
  };
  const layer = Layer.merge(
    Layer.succeed(MainLogger, logger.service),
    Layer.succeed(LoggingTransport, transport)
  );
  if (filter.issues.length)
    logger.service.scopedSync('logging').warn('Invalid logging configuration; using safe defaults');
  return { service: logger.service, transport, layer };
}

export const MainLoggerLive = Layer.unwrapEffect(Effect.sync(() => makeMainLogging().layer));
