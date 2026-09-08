import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectTelemetryException } from '../../src/shared/telemetry-exception';

afterEach(() => vi.unstubAllGlobals());

describe('exception source-map projection', () => {
  it('preserves renderer chunk IDs while removing content, paths and function labels', () => {
    const filename = 'file:///Users/private/app/assets/main-abcd.js';
    const injected = `Error\n    at ${filename}:1:1`;
    const chunk = '32d7d196-2875-4a68-8bd3-f1404d05cd15';
    vi.stubGlobal('_posthogChunkIds', { [injected]: chunk });
    const error = new TypeError('private content');
    error.stack = `TypeError: private content\n    at privateFunction (${filename}:12:34)`;
    const projected = projectTelemetryException(error, 'renderer');
    expect(projected.frames).toEqual([
      {
        filename: 'assets/main-abcd.js',
        lineno: 12,
        colno: 34,
        platform: 'web:javascript',
        chunk_id: chunk,
      },
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/private|privateFunction/);
    const relayed = projectTelemetryException(
      { name: projected.name, message: projected.message, frames: projected.frames },
      'renderer'
    );
    expect(relayed.frames).toEqual(projected.frames);
  });
  it('contains malformed source frame getters', () => {
    const frame = {
      get filename() {
        throw new Error('getter failed');
      },
    };
    expect(projectTelemetryException({ frames: [frame] }, 'renderer').frames).toEqual([]);
  });
  it('parses main stacks and rejects malformed forwarded coordinates/chunk IDs', () => {
    const error = new Error('private');
    error.stack = 'Error: private\n    at fn (/Users/private/app/.vite/build/entry.js:20:10)';
    expect(projectTelemetryException(error, 'main').frames[0]).toMatchObject({
      filename: '.vite/build/entry.js',
      lineno: 20,
      colno: 10,
    });
    expect(
      projectTelemetryException(
        {
          frames: [
            { filename: 'entry.js', lineno: -1, colno: 5 },
            { filename: 'entry.js', lineno: 2, colno: 5, chunk_id: 'secret' },
          ],
        },
        'renderer'
      ).frames
    ).toEqual([]);
  });
});
