import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Effect } from 'effect';
import {
  LIMITS,
  byteLength,
  formatJsonLine,
  makeFilter,
  makeLineDecoder,
  makeLogger,
  makeRecord,
  makeWire,
  normalizeError,
  normalizeUnexpectedError,
  parseRecord,
  parseWire,
  type LogRecord,
} from '../src/index';

const origin = {
  app: 'fixture',
  appVersion: '1.0',
  buildId: 'build-1',
  appRunId: 'launch-1',
};
const source = { runtime: 'main' as const, pid: 12 };
const timestamp = '2026-09-08T00:00:00.000Z';

test('retained record validation preserves safe diagnostics and rejects forged envelopes', () => {
  const record = makeRecord(
    makeWire(
      'info',
      'recording',
      'Attempt ended',
      {
        context: { recordingId: 'rec-1', durationMs: 12 },
      },
      timestamp
    ),
    origin,
    source
  );
  assert.deepEqual(parseRecord(record, origin.app), record);
  for (const patch of [
    { app: 'another-app' },
    { appRunId: 'bad/run' },
    { appRunId: 'x'.repeat(129) },
    { appVersion: null },
    { runtime: 'forged' },
    { pid: -1 },
    { pid: 1.5 },
    { schemaVersion: 2 },
  ])
    assert.equal(parseRecord({ ...record, ...patch }, origin.app), undefined);
  const sanitized = parseRecord(
    {
      ...record,
      unknownEnvelopeField: 'private extra',
      context: { transcript: 'private transcript', recordingId: 'rec-1' },
      error: { name: 'Error', message: 'https://host/callback?code=private-code', code: 'EIO' },
    },
    origin.app
  )!;
  assert.equal(sanitized.context?.recordingId, 'rec-1');
  assert.equal(sanitized.context?.transcript, '[redacted]');
  assert.equal(sanitized.error?.code, 'EIO');
  assert.doesNotMatch(
    JSON.stringify(sanitized),
    /private extra|private transcript|private-code|unknownEnvelopeField/
  );
  assert.equal(parseRecord({ schemaVersion: 1, appRunId: origin.appRunId }, origin.app), undefined);
});

test('destination filter conformance', () => {
  for (const [config, scope, expected] of [
    [{ isDev: false }, 'audio', [false, true, true, true, false, false, true, true]],
    [{ isDev: true }, 'audio', [true, true, true, true, true, true, true, true]],
    [
      { isDev: false, debugScopes: 'audio' },
      'audio',
      [true, true, true, true, false, false, true, true],
    ],
    [
      { isDev: false, debugScopes: 'audio' },
      'db',
      [false, true, true, true, false, false, true, true],
    ],
    [
      { isDev: true, debugScopes: 'audio' },
      'db',
      [false, true, true, true, false, true, true, true],
    ],
    [
      { isDev: false, debugScopes: 'audio', logLevel: 'warn' },
      'audio',
      [false, false, true, true, false, false, true, true],
    ],
    [
      { isDev: false, debugScopes: 'audio', logLevel: 'debug' },
      'db',
      [true, true, true, true, true, true, true, true],
    ],
  ] as const) {
    const filter = makeFilter(config);
    const result = (['file', 'console'] as const).flatMap(destination =>
      (['debug', 'info', 'warn', 'error'] as const).map(level =>
        filter.enabled(level, scope, destination)
      )
    );
    assert.deepEqual(result, expected);
  }
});

test('scope patterns are bounded, case insensitive, and invalid controls use defaults', () => {
  const selected = makeFilter({
    isDev: false,
    debugScopes: 'Audio,/whisper.*/',
  });
  assert.equal(selected.enabled('debug', 'audio', 'file'), true);
  assert.equal(selected.enabled('debug', 'whisper.worker', 'file'), true);
  assert.equal(selected.enabled('debug', 'preaudio', 'file'), false);
  for (const pattern of ['/[invalid/', '/(a+)+$/', 'a'.repeat(1025)]) {
    const filter = makeFilter({
      isDev: false,
      logLevel: 'silly',
      debugScopes: pattern,
    });
    assert.equal(filter.issues.length, 2);
    assert.equal(filter.enabled('debug', 'audio', 'file'), false);
    assert.equal(filter.enabled('info', 'audio', 'console'), false);
  }
});

test('scope regexes reject costly repetition while preserving the supported subset', () => {
  for (const debugScopes of [
    '/a+a+a+a+a+$/',
    '/(a|aa)(a|aa)$/',
    '/a{1000000}/',
    '/a.*?/',
    '/a?\\w+$/',
    '/\\1/',
  ]) {
    const filter = makeFilter({ isDev: false, debugScopes });
    assert.equal(filter.issues.length, 1, debugScopes);
    assert.equal(filter.enabled('debug', 'a'.repeat(127) + '!', 'file'), false);
  }
  for (const [debugScopes, scope] of [
    ['/whisper.*/', 'whisper.worker'],
    ['/^audio|whisper$/', 'audio'],
    ['/^[a-z.*+?(){}]+$/', 'audio()'],
    ['/^worker\\.\\+$/', 'worker.+'],
    ['worker.+', 'worker.+'],
  ]) {
    const filter = makeFilter({ isDev: false, debugScopes });
    assert.deepEqual(filter.issues, [], debugScopes);
    assert.equal(filter.enabled('debug', scope, 'file'), true, debugScopes);
    assert.equal(filter.enabled('debug', scope, 'console'), false);
  }
});

test('both service execution boundaries write the same structured records', async () => {
  const output: LogRecord[] = [];
  const logger = makeLogger(
    (record, targets) => {
      assert.deepEqual(targets, { file: true, console: true });
      output.push(record);
    },
    { origin, source, filter: makeFilter({ isDev: true }) }
  );
  const metadata = {
    context: { recordingId: 'recording-1', absent: undefined, durationMs: 1 },
    error: Object.assign(new Error('Worker failed'), {
      code: 'EPIPE',
      _tag: 'WorkerError',
    }),
  };
  await Effect.runPromise(logger.service.scoped('audio').error('Capture failed', metadata));
  logger.service.scopedSync('audio').error('Capture failed', metadata);
  assert.equal(logger.service.appRunId, origin.appRunId);
  assert.equal(output.length, 2);
  assert.deepEqual({ ...output[0], timestamp }, { ...output[1], timestamp });
  assert.equal(output[0]!.error?.code, 'EPIPE');
  assert.equal(output[0]!.error?.tag, 'WorkerError');
  assert.equal('absent' in output[0]!.context!, false);
});

test('privacy controls cover context, errors, messages, and export-ready lines', () => {
  const error = Object.assign(
    new Error('password=secret-password https://example.test/callback?code=oauth-secret'),
    {
      stack:
        'Error: Bearer bearer-secret\n    at /Users/alice/project/src/app.ts:5:1\n    at C:\\Users\\bob\\app\\main.js:4:2',
      cause: new Error(
        'access_token=token-secret {"apiKey":"encoded-secret"} token=generic-secret'
      ),
      response: 'unrestricted-response',
    }
  );
  const record = makeRecord(
    makeWire(
      'error',
      'auth',
      'Login failed for alice@example.test',
      {
        context: {
          apiKey: 'private-key',
          transcript: 'private-transcript',
          prompt: 'private-prompt',
          responseBody: 'private-response',
          nested: { authorization: 'private-auth', noteId: 'note-1' },
        },
        error,
      },
      timestamp
    ),
    origin,
    source
  );
  const line = formatJsonLine(record);
  for (const value of [
    'secret-password',
    'oauth-secret',
    'bearer-secret',
    'alice',
    'bob',
    'token-secret',
    'encoded-secret',
    'generic-secret',
    'unrestricted-response',
    'private-key',
    'private-transcript',
    'private-prompt',
    'private-response',
    'private-auth',
  ])
    assert.equal(line.includes(value), false, value);
  assert.equal(line.includes('note-1'), true);
  assert.equal(line.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(line), record);
});

test('wire ingress uses trusted process context and rejects invalid shapes', () => {
  const output: LogRecord[] = [];
  const logger = makeLogger(record => output.push(record), {
    origin,
    source,
    filter: makeFilter({ isDev: true }),
  });
  const wire = makeWire('warn', 'worker', 'Worker exited', { context: { code: 1 } }, timestamp);
  const trusted = { runtime: 'worker' as const, pid: 42, surface: 'widget' };
  assert.equal(
    logger.ingest(
      {
        ...wire,
        app: 'spoof',
        appRunId: 'spoof',
        pid: 999,
        runtime: 'main',
        surface: 'spoof',
      },
      trusted
    ),
    true
  );
  assert.deepEqual(output[0], { ...wire, ...origin, ...trusted });
  for (const invalid of [
    null,
    [],
    { ...wire, level: 'fatal' },
    { ...wire, timestamp: 'today' },
    { ...wire, schemaVersion: 2 },
    { ...wire, context: 'raw' },
  ])
    assert.equal(logger.ingest(invalid, trusted), false);
  assert.equal(output.length, 1);
});

test('cycles, throwing getters, excessive causes, and non-finite numbers cannot break logging', () => {
  const context: Record<string, unknown> = { count: NaN, ok: true };
  context.circular = context;
  Object.defineProperty(context, 'getter', {
    enumerable: true,
    get() {
      throw new Error('private-getter');
    },
  });
  const error = new Error('Failure', {
    cause: new Error('Cause', {
      cause: new Error('Nested', { cause: new Error('Over budget') }),
    }),
  });
  const wire = makeWire(
    'error',
    'test',
    'Failure',
    { context: context as never, error },
    timestamp
  );
  assert.equal(wire.context?.count, null);
  assert.equal(wire.context?.circular, '[circular]');
  assert.equal(wire.error?.cause?.cause?.cause?.truncated, true);
  const cycle = Object.assign(new Error('Cycle'), { cause: {} });
  cycle.cause = cycle;
  assert.equal(normalizeError(cycle).cause?.message, '[circular]');
  assert.equal(parseWire(wire)?.error?.name, 'Error');
});

test('large Unicode records keep the envelope and error code within the byte budget', () => {
  const context = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`field${index}`, '😀'.repeat(2048)])
  );
  const record = makeRecord(
    makeWire(
      'error',
      'test',
      '😀'.repeat(10000),
      {
        context,
        error: Object.assign(new Error('x'.repeat(10000)), { code: 'EPIPE' }),
      },
      timestamp
    ),
    origin,
    source
  );
  assert.ok(byteLength(formatJsonLine(record)) <= LIMITS.recordBytes);
  assert.equal(record.truncated, true);
  assert.equal(record.error?.code, 'EPIPE');
  assert.equal(record.appRunId, 'launch-1');
});

test('truncation markers count toward object and array limits', () => {
  const context = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`field${index}`, index])
  );
  const wire = makeWire('info', 'test', 'Bounded', { context }, timestamp);
  assert.equal(Object.keys(wire.context!).length, LIMITS.keys);
  assert.equal(wire.context?._truncated, true);
  const array = makeWire(
    'info',
    'test',
    'Bounded',
    { context: { values: Array.from({ length: 40 }, (_, index) => index) } },
    timestamp
  ).context!.values;
  assert.equal((array as unknown[]).length, LIMITS.arrayItems);
});

test('filtered metadata is not inspected and sink failures never escape into product work', async () => {
  let reads = 0;
  const metadata = {
    get context(): never {
      reads++;
      throw new Error('must not inspect');
    },
  };
  const logger = makeLogger(
    () => {
      throw new Error('disk unavailable');
    },
    { origin, source, filter: makeFilter({ isDev: false }) }
  );
  logger.service.scopedSync('test').debug('Filtered', metadata);
  assert.equal(reads, 0);
  logger.service.scopedSync('test').error('Failure');
  await Effect.runPromise(logger.service.scoped('test').error('Failure'));
});

test('stream decoder preserves split UTF-8 and line boundaries', () => {
  const decoder = makeLineDecoder();
  const input = new TextEncoder().encode('a😀b\r\nsecond\nlast');
  const first = decoder.push(input.subarray(0, 3));
  const second = decoder.push(input.subarray(3));
  assert.deepEqual(first, { lines: [], dropped: 0 });
  assert.deepEqual(second, { lines: ['a😀b', 'second'], dropped: 0 });
  assert.deepEqual(decoder.end(), { lines: ['last'], dropped: 0 });
});

test('oversized fragments and flood batches drain with accurate drop accounting', () => {
  const decoder = makeLineDecoder();
  assert.deepEqual(decoder.push('x'.repeat(LIMITS.lineBytes + 1)), {
    lines: [],
    dropped: 1,
  });
  assert.deepEqual(decoder.push('rest\ngood\n'), {
    lines: ['good'],
    dropped: 0,
  });
  const flood = decoder.push('line\n'.repeat(1000));
  assert.equal(flood.lines.length, LIMITS.queueRecords);
  assert.equal(flood.dropped, 1000 - LIMITS.queueRecords);
  const bytes = decoder.push(`${'x'.repeat(16000)}\n`.repeat(128));
  assert.ok(bytes.lines.length < LIMITS.queueRecords);
  assert.equal(bytes.lines.length + bytes.dropped, 128);
});

test('truncation evidence survives wire and retained-record reprojection', () => {
  const wire = makeWire('error', 'fixture', 'Operation failed', {
    context: { values: Array(32).fill('x'.repeat(2048)) },
    error: new AggregateError(
      Array.from({ length: 4 }, () => new Error('failure')),
      'aggregate'
    ),
  });
  assert.equal(wire.truncated, true);
  assert.equal(wire.error?.truncated, true);
  const relayed = parseWire(JSON.parse(JSON.stringify(wire)))!;
  const exported = parseRecord(makeRecord(relayed, origin, source), origin.app)!;
  assert.equal(exported.truncated, true);
  assert.equal(exported.error?.truncated, true);
  assert.equal(exported.error?.causes?.length, 3);
});

test('credential headers and complete home directory names never reach JSONL', () => {
  const error = new Error(
    'Authorization: Basic dXNlcjpwYXNz\nCookie: session=PRIVATE_COOKIE; other=PRIVATE_OTHER\nSet-Cookie: id=PRIVATE_SET_COOKIE\nCookie: session=first}PRIVATE_COOKIE_TAIL'
  );
  error.stack =
    'Error: failed\n    at C:\\Users\\Jane Doe\\app\\main.js:4:2\n    at /Users/John Smith/app/main.js:5:3';
  const record = makeRecord(makeWire('error', 'test', error.message, { error }), origin, source);
  const output = formatJsonLine(record);
  assert.doesNotMatch(
    output,
    /dXNlcjpwYXNz|PRIVATE_COOKIE|PRIVATE_OTHER|PRIVATE_SET_COOKIE|Jane|Doe|John|Smith/
  );
  assert.match(output, /main\.js:4:2/);
  assert.match(output, /main\.js:5:3/);
});

test('unexpected error projection preserves bounded classification and frames without prose', () => {
  const cause = Object.assign(new Error('PRIVATE_CAUSE'), { code: 'ENOENT' });
  cause.stack =
    'Error: PRIVATE_CAUSE\n    at PRIVATE_FUNCTION (/Users/private/app/assets/worker.js:9:2)';
  const error = Object.assign(new Error('PRIVATE_MESSAGE', { cause }), {
    _tag: 'WorkerCrashed',
    reason: 'worker-exited',
    code: 'EPIPE',
  });
  error.stack =
    'Error: PRIVATE_MESSAGE\nPRIVATE_EXTRA_LINE\n    at PRIVATE_FUNCTION (/Users/private/app/assets/main.js:12:3)';
  const safe = normalizeUnexpectedError(error);
  assert.equal(safe.tag, 'WorkerCrashed');
  assert.equal(safe.code, 'EPIPE');
  assert.equal(safe.reason, 'worker-exited');
  assert.equal(safe.cause?.code, 'ENOENT');
  assert.equal(safe.stack, '    at assets/main.js:12:3');
  assert.equal(safe.cause?.stack, '    at assets/worker.js:9:2');
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_|Users\/private/);
  assert.equal(normalizeUnexpectedError('PRIVATE_REJECTION').message, 'Failure captured');
  const queryError = new Error('private');
  queryError.stack =
    'Error: private\n    at load (https://host/assets/main.js?token=PRIVATE_QUERY:12:3)';
  assert.equal(normalizeUnexpectedError(queryError).stack, '    at assets/main.js:12:3');
});
