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

  it('retains skill timing correlation, phases, outcomes and known error codes', () => {
    const properties = {
      attempt_id: 'c61d78d1-1244-45fa-a731-7645c645b260',
      execution_id: 'timing-abc-2-123',
      request_id: 'req_123',
      client_at_ms: 1_783_000_000_000,
      elapsed_ms: 2_000,
      duration_ms: 5_000,
      execution_duration_ms: 4_900,
      queued_ms: 100,
      preparing_ms: 120,
      request_ms: 3_000,
      transcript_wait_ms: 1_800,
      staging_ms: 80,
      request_count: 2,
      phase: 'waiting-transcript',
      status: 'skipped',
      error_code: 'TRANSCRIPT_FINALIZING',
    };
    expect(sanitizeTelemetryProperties(properties)).toEqual(properties);
    for (const error_code of ['PROVIDER_QUOTA_EXCEEDED', 'NETWORK_ERROR', 'EDITOR_UNAVAILABLE']) {
      expect(sanitizeTelemetryProperties({ error_code })).toEqual({ error_code });
    }
    expect(sanitizeTelemetryProperties({ request_id: null })).toEqual({ request_id: null });
  });

  it('retains bootstrap and local/cloud note-loading milestones', () => {
    const properties = {
      kind: 'sync_bootstrap',
      status: 'published',
      persistence_ready_ms: 20,
      notes_loaded_ms: 200,
      folders_failed_ms: 220,
      tags_loaded_ms: 230,
      note_tags_loaded_ms: 240,
    };
    expect(sanitizeTelemetryProperties(properties)).toEqual(properties);
    const note = {
      kind: 'note_collaboration',
      status: 'ready',
      create_gate_released_ms: 20,
      token_requested_ms: 21,
      token_resolved_ms: 30,
      socket_connected_ms: 40,
      authenticated_ms: 50,
      document_synced_ms: 60,
      local_log_hydrated_ms: 10,
    };
    expect(sanitizeTelemetryProperties(note)).toEqual(note);
  });

  it('retains first-note walkthrough metadata without trusting a renderer-supplied organization', () => {
    const properties = {
      tour: 'first_note',
      tour_version: 1,
      replay: false,
      step: 'record',
      action: 'recording',
      code: 'recording_failed',
    };
    expect(sanitizeTelemetryProperties({ ...properties, org_id: 'org_other' })).toEqual(properties);
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
        attempt_id: 'private request context',
        request_id: 'https://private.test/request',
        execution_id: 'x'.repeat(129),
        phase: 'private notes',
        status: 'provider response with secret',
        kind: 'private workspace',
        action: 'private words',
        step: 'private words',
        code: 'private provider message',
        tour: 'private words',
        request_ms: Infinity,
        client_at_ms: -1,
        private_milestone_ms: 10,
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
