import { describe, expect, it } from 'vitest';
import {
  sanitizeTelemetryError,
  sanitizeTelemetryProperties,
} from '../../src/shared/telemetry-payload';

describe('telemetry properties', () => {
  it('preserves existing product metadata without user-authored skill names', () => {
    const properties = {
      note_id: 'nt_abc123',
      recording_id: 'rec_abc123',
      segments: 12,
      skill_id: 'skl_abc123',
      model_id: 'anthropic/claude-sonnet-4',
      source: 'auto-enhance',
      mode: 'append-section',
      scoped_to_recording: true,
      skill_name: 'Private customer notes',
      from_folder: false,
      grace_ms: 30_000,
    };
    const { skill_name: _, ...safe } = properties;
    expect(sanitizeTelemetryProperties(properties)).toEqual(safe);
  });

  it('retains diagnostics and sharing/Ask metadata with their current field meanings', () => {
    const properties = {
      source: 'renderer-process',
      stage: 'window-load',
      reason: 'crashed',
      exit_code: -1,
      window_type: 'widget',
      resource_type: 'note',
      method: 'email_invitation',
      role: 'editor',
      conversation_id: null,
      has_context: true,
      suggestion_source: 'followup',
      error_code: 'ENOENT',
    };
    expect(sanitizeTelemetryProperties(properties)).toEqual(properties);
  });

  it('drops secrets, content, arbitrary enums, nested values and non-finite/oversized metadata', () => {
    expect(
      sanitizeTelemetryProperties({
        token: 'secret',
        prompt: 'private words',
        transcript: 'private words',
        note_id: 'https://private.test/note',
        recording_id: 'x'.repeat(129),
        skill_id: { token: 'secret' },
        model_id: '/Users/private/models/model.bin',
        source: 'private-words',
        stage: '/Users/private/startup',
        reason: 'secret text',
        segments: Infinity,
        grace_ms: -1,
        duration_ms: Number.MAX_SAFE_INTEGER + 1,
        exit_code: 0.5,
        error_code: 'private-token',
        $exception_list: [{ message: 'secret' }],
      })
    ).toEqual({});
  });

  it('does not throw for absent, cyclic or throwing inputs', () => {
    const input: Record<string, unknown> = {};
    input.note_id = input;
    Object.defineProperty(input, 'source', {
      get() {
        throw new Error('private');
      },
    });
    for (const value of [
      null,
      undefined,
      'private',
      input,
      new Proxy(
        {},
        {
          get() {
            throw 1;
          },
        }
      ),
    ]) {
      expect(sanitizeTelemetryProperties(value)).toEqual({});
    }
  });
});

describe('telemetry errors', () => {
  it('replaces sensitive messages while retaining a recognized exception type and safe coordinates', () => {
    const original = new TypeError('secret token and private transcript');
    original.stack =
      'TypeError: secret token\n    at finish (/Users/alice/private-project/.vite/build/main.js:12:3)\n    at render (https://private.test/assets/index.js?token=secret:42:7)\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)';
    const result = sanitizeTelemetryError(original);
    expect(result.name).toBe('TypeError');
    expect(result.message).toBe('TypeError captured');
    expect(result.stack).toBe(
      'TypeError: TypeError captured\n    at .vite/build/main.js:12:3\n    at assets/index.js:42:7\n    at node:internal/process/task_queues:105:5'
    );
    expect(original.message).toContain('secret');
  });

  it('accepts renderer DTOs and Windows paths without retaining local user directories', () => {
    const result = sanitizeTelemetryError({
      name: 'ReferenceError',
      message: 'private',
      stack:
        'ReferenceError: private\n    at run (C:\\Users\\alice\\AppData\\Prismical\\resources\\app.asar\\.vite\\build\\main.js:9:2)',
      cause: new Error('secret'),
      token: 'secret',
    });
    expect(result.stack).toBe(
      'ReferenceError: ReferenceError captured\n    at app.asar/.vite/build/main.js:9:2'
    );
    expect(result.cause).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('preserves known domain classification and excludes arbitrary names, codes and reasons', () => {
    const result = sanitizeTelemetryError({
      _tag: 'WhisperEngineError',
      message: 'private',
      reason: 'worker-crashed',
      code: 'EPIPE',
    });
    expect(result).toMatchObject({
      name: 'WhisperEngineError',
      reason: 'worker-crashed',
      code: 'EPIPE',
    });
    const unknown = sanitizeTelemetryError({
      name: 'SecretCustomerError',
      message: 'private',
      code: 'secret',
      reason: 'secret',
      stack: 'secret',
    });
    expect(unknown.name).toBe('Error');
    expect(unknown.stack).toBe('Error: Error captured');
    expect(unknown).not.toHaveProperty('code');
    expect(unknown).not.toHaveProperty('reason');
  });

  it('bounds frames and never invents a stack for non-Error thrown values', () => {
    const manyFrames = {
      stack: `Error: secret\n${'    at fn (/Users/alice/app/src/main.ts:1:2)\n'.repeat(1000)}`,
    };
    expect(sanitizeTelemetryError(manyFrames).stack?.split('\n')).toHaveLength(21);
    for (const input of [
      'secret',
      null,
      new Proxy(
        {},
        {
          get() {
            throw 1;
          },
        }
      ),
    ]) {
      expect(sanitizeTelemetryError(input).stack).toBe('Error: Error captured');
    }
  });
});
