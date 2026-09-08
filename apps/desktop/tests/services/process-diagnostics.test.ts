import { describe, expect, it } from 'vitest';
import { LIMITS, makeFilter, makeLogger, makeWire, type LogRecord } from '@desktop/logging';
import { makeProcessDiagnostics } from '../../src/main/infra/logging/process-diagnostics';

describe('native diagnostic pipe', () => {
  function fixture() {
    const records: LogRecord[] = [];
    const transport = makeLogger(record => records.push(record), {
      origin: { app: 'prismical', appVersion: 'test', appRunId: 'run-1' },
      source: { runtime: 'main', pid: 1 },
      filter: makeFilter({ isDev: true }),
    });
    return {
      records,
      pipe: makeProcessDiagnostics(
        transport,
        () => ({ runtime: 'native', pid: 42 }),
        'audio-capture'
      ),
    };
  }
  it('retains split structured records and supplies trusted process identity', () => {
    const { records, pipe } = fixture();
    const wire = {
      ...makeWire('error', 'audio-capture', 'Capture failed', {
        error: Object.assign(new Error('EPIPE'), {
          code: 'EPIPE',
          cause: new Error('child failed'),
        }),
      }),
      pid: 999,
      appRunId: 'spoofed',
    };
    const bytes = Buffer.from(JSON.stringify(wire) + '\n');
    pipe.push(bytes.subarray(0, 30));
    expect(records).toHaveLength(0);
    pipe.push(bytes.subarray(30));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runtime: 'native',
      pid: 42,
      appRunId: 'run-1',
      level: 'error',
      error: { code: 'EPIPE', cause: { name: 'Error' } },
    });
  });
  it('drains oversized and unstructured output without retaining its contents', () => {
    const { records, pipe } = fixture();
    pipe.push(Buffer.from('private transcript\n' + 'x'.repeat(LIMITS.lineBytes + 1)));
    pipe.push(Buffer.from('\nprivate tail'));
    pipe.end();
    expect(JSON.stringify(records)).not.toContain('private');
    expect(records.some(row => row.context?.droppedLines === 1)).toBe(true);
    expect(records.every(row => row.level === 'debug')).toBe(true);
  });
});
