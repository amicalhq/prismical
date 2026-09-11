import { describe, expect, it } from 'vitest';
import {
  CHANNELS,
  isAllowedTransportPath,
  parseCollabOpenRequest,
  parseCollabTokenResult,
  parseInboundCollabMessage,
  parseInboundStreamMessage,
  parseModelRequest,
  parseModelsStateView,
  parseOutboundCollabMessage,
  parseNavPush,
  parseOpenStreamRequest,
  parseOpenWebSessionRequest,
  parseRecordingE2ECommand,
  parseRecordingControlRequest,
  parseRecordingStateView,
  parseSessionChangedPush,
  parseSessionView,
  parseSignInResult,
  parseSignOutRequest,
  parseStartRecordingRequest,
  recordingLanguageRequestSchema,
  parseStopRecordingRequest,
  parseSwitchAccountRequest,
  parseSwitchOrgRequest,
  parseAiModelListRequest,
  parseAiModelListing,
  parseAiProviderKeyRequest,
  parseAiProviderRequest,
  parseTranscriptionByokKeyRequest,
  parseTransportRequest,
  streamPortChannel,
  updateStatusSchema,
  telemetryPlanIdentityRequestSchema,
  type ModelsStateView,
} from '@prismical/desktop-contracts';
import type { LocalModelsState } from '@prismical/app-contracts';

describe('transport path allowlist', () => {
  it('admits only /apps/v1/me and descendants', () => {
    expect(isAllowedTransportPath('/apps/v1/me')).toBe(true);
    expect(isAllowedTransportPath('/apps/v1/me/notes')).toBe(true);
    expect(isAllowedTransportPath('/apps/v1/me/notes?x=1')).toBe(true);
    expect(isAllowedTransportPath('/apps/v1/meow')).toBe(false);
    expect(isAllowedTransportPath('/v1/other')).toBe(false);
    expect(isAllowedTransportPath('/apps/v1')).toBe(false);
    expect(isAllowedTransportPath('')).toBe(false);
  });

  it('rejects dot-segment traversal and backslashes before fetch', () => {
    // A single '..' segment escapes the prefix once a URL resolver normalizes.
    expect(isAllowedTransportPath('/apps/v1/me/../admin')).toBe(false);
    expect(isAllowedTransportPath('/apps/v1/me/../../admin')).toBe(false);
    expect(isAllowedTransportPath('/apps/v1/me/..')).toBe(false);
    // Backslashes are path separators on Windows / after normalization.
    expect(isAllowedTransportPath('/apps/v1/me\\x')).toBe(false);
    // An absolute URL is not a bare path — the literal prefix must match.
    expect(isAllowedTransportPath('https://evil/apps/v1/me')).toBe(false);
  });
});

describe('schema parse helpers', () => {
  it('requires a bounded, account-and-org-scoped plan identity with a telemetry revision', () => {
    const plan = { accountId: 'user_1', orgId: 'org_1', planExternalId: 'plan_free', revision: 1 };
    expect(telemetryPlanIdentityRequestSchema.safeParse(plan).success).toBe(true);
    expect(
      telemetryPlanIdentityRequestSchema.safeParse({ ...plan, planExternalId: null }).success
    ).toBe(true);
    expect(telemetryPlanIdentityRequestSchema.safeParse({ ...plan, accountId: '' }).success).toBe(
      false
    );
    expect(telemetryPlanIdentityRequestSchema.safeParse({ ...plan, orgId: '' }).success).toBe(
      false
    );
    expect(telemetryPlanIdentityRequestSchema.safeParse({ ...plan, revision: -1 }).success).toBe(
      false
    );
    expect(
      telemetryPlanIdentityRequestSchema.safeParse({ ...plan, planExternalId: 'x'.repeat(201) })
        .success
    ).toBe(false);
    expect(
      telemetryPlanIdentityRequestSchema.safeParse({ ...plan, has_appsumo_org: true }).success
    ).toBe(false);
  });

  it('parses a valid transport request', () => {
    const result = parseTransportRequest({ method: 'GET', path: '/apps/v1/me' });
    expect(result.success).toBe(true);
  });

  it('distinguishes an updater-disabled build from a completed no-update check', () => {
    expect(updateStatusSchema.safeParse('disabled').success).toBe(true);
    expect(updateStatusSchema.safeParse('not-available').success).toBe(true);
    expect(updateStatusSchema.safeParse('not-implemented').success).toBe(false);
  });

  it('rejects unknown methods and missing paths with issue strings', () => {
    const bad = parseTransportRequest({ method: 'YEET', path: '/apps/v1/me' });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.issues.join(' ')).toContain('method');
    expect(parseTransportRequest({ method: 'GET' }).success).toBe(false);
    expect(parseTransportRequest(null).success).toBe(false);
  });

  it('openStream requires a UUID streamId and POST', () => {
    const id = '9b7f4a4e-8f2a-4f6e-9a7c-2f1d3e4b5a6c';
    expect(
      parseOpenStreamRequest({ streamId: id, method: 'POST', path: '/apps/v1/me/ask' }).success
    ).toBe(true);
    expect(
      parseOpenStreamRequest({ streamId: 'nope', method: 'POST', path: '/apps/v1/me/ask' }).success
    ).toBe(false);
    expect(
      parseOpenStreamRequest({ streamId: id, method: 'GET', path: '/apps/v1/me/ask' }).success
    ).toBe(false);
  });

  it('web handoff accepts only same-origin relative return paths', () => {
    expect(
      parseOpenWebSessionRequest({
        returnPath: '/home?from=desktop',
        activeOrgId: 'org-1',
      }).success
    ).toBe(true);
    expect(parseOpenWebSessionRequest({ returnPath: '/home', activeOrgId: '' }).success).toBe(
      false
    );
    expect(parseOpenWebSessionRequest({ returnPath: '//evil.example' }).success).toBe(false);
    expect(parseOpenWebSessionRequest({ returnPath: 'https://evil.example' }).success).toBe(false);
    expect(parseOpenWebSessionRequest({ returnPath: '/\\evil.example' }).success).toBe(false);
  });

  it('inbound stream messages: resume with parts, abort, nothing else', () => {
    expect(parseInboundStreamMessage({ type: 'resume', parts: [] }).success).toBe(true);
    expect(parseInboundStreamMessage({ type: 'abort' }).success).toBe(true);
    expect(parseInboundStreamMessage({ type: 'resume' }).success).toBe(false);
    expect(parseInboundStreamMessage({ type: 'evil' }).success).toBe(false);
    expect(parseInboundStreamMessage('abort').success).toBe(false);
  });

  it('collab:open requires a UUID openId and a non-empty noteId', () => {
    const id = '9b7f4a4e-8f2a-4f6e-9a7c-2f1d3e4b5a6c';
    expect(parseCollabOpenRequest({ openId: id, noteId: 'nt_1' }).success).toBe(true);
    expect(parseCollabOpenRequest({ openId: 'nope', noteId: 'nt_1' }).success).toBe(false);
    expect(parseCollabOpenRequest({ openId: id, noteId: '' }).success).toBe(false);
    expect(parseCollabOpenRequest({ openId: id, noteId: 'nt_1', extra: 1 }).success).toBe(false);
  });

  it('inbound collab messages: update/flush/compact and persistence barriers', () => {
    const bytes = Uint8Array.from([1, 2]);
    expect(parseInboundCollabMessage({ type: 'update', data: bytes }).success).toBe(true);
    expect(parseInboundCollabMessage({ type: 'update', data: 'text' }).success).toBe(false);
    expect(
      parseInboundCollabMessage({ type: 'flush', text: 'a', markdown: null, firstLine: 'a' })
        .success
    ).toBe(true);
    expect(
      parseInboundCollabMessage({ type: 'flush', text: 'a', markdown: '# a', firstLine: 'a' })
        .success
    ).toBe(true);
    expect(parseInboundCollabMessage({ type: 'flush', text: 'a' }).success).toBe(false);
    expect(parseInboundCollabMessage({ type: 'compact', upTo: 3, state: bytes }).success).toBe(
      true
    );
    expect(parseInboundCollabMessage({ type: 'compact', upTo: -1, state: bytes }).success).toBe(
      false
    );
    expect(parseInboundCollabMessage({ type: 'abort' }).success).toBe(false);
    expect(parseInboundCollabMessage('update').success).toBe(false);
    expect(parseInboundCollabMessage({ type: 'barrier', requestId: 'barrier_1' }).success).toBe(
      true
    );
    expect(parseInboundCollabMessage({ type: 'barrier', requestId: '' }).success).toBe(false);
  });

  it('outbound collab messages: update blobs + the hydrated marker + resync', () => {
    const bytes = Uint8Array.from([1]);
    expect(parseOutboundCollabMessage({ type: 'update', data: bytes }).success).toBe(true);
    expect(parseOutboundCollabMessage({ type: 'hydrated', seq: 0, count: 0 }).success).toBe(true);
    expect(parseOutboundCollabMessage({ type: 'resync' }).success).toBe(true);
    expect(parseOutboundCollabMessage({ type: 'resync', seq: 1 }).success).toBe(false);
    expect(parseOutboundCollabMessage({ type: 'hydrated', seq: 1.5, count: 0 }).success).toBe(
      false
    );
    expect(parseOutboundCollabMessage({ type: 'done' }).success).toBe(false);
    expect(
      parseOutboundCollabMessage({ type: 'barrier', requestId: 'barrier_1', ok: true }).success
    ).toBe(true);
    expect(parseOutboundCollabMessage({ type: 'barrier', requestId: 'barrier_1' }).success).toBe(
      false
    );
  });

  it('nav push payloads', () => {
    expect(parseNavPush({ path: '/notes' }).success).toBe(true);
    expect(
      parseNavPush({ path: '/settings/billing', notice: 'floating-mode-unavailable' })
    ).toEqual({
      success: true,
      data: { path: '/settings/billing', notice: 'floating-mode-unavailable' },
    });
    expect(parseNavPush({ path: '/settings/billing', notice: 'unknown' }).success).toBe(false);
    expect(parseNavPush({ path: '' }).success).toBe(false);
    expect(parseNavPush({}).success).toBe(false);
  });
});

describe('auth schemas', () => {
  const view = {
    state: 'signed-in',
    accounts: [{ sub: 'user-1', email: 'ada@prismical.ai', name: 'Ada', activeOrgId: 'org-1' }],
    activeSub: 'user-1',
  };

  it('parses a sanitized session view (optional name/activeOrgId/activeSub)', () => {
    expect(parseSessionView(view).success).toBe(true);
    expect(parseSessionView({ state: 'signed-out', accounts: [] }).success).toBe(true);
    expect(
      parseSessionView({
        state: 'signing-in',
        accounts: [{ sub: 'u', email: 'u@x.y' }],
      }).success
    ).toBe(true);
  });

  it('gate state is a closed enum', () => {
    for (const state of ['signed-out', 'signing-in', 'signed-in', 'refreshing', 'offline']) {
      expect(parseSessionView({ state, accounts: [] }).success).toBe(true);
    }
    expect(parseSessionView({ state: 'authenticated', accounts: [] }).success).toBe(false);
    expect(parseSessionView({ accounts: [] }).success).toBe(false);
  });

  it('is structurally incapable of carrying tokens (.strict() rejects token-shaped keys)', () => {
    for (const key of ['refreshToken', 'idToken', 'accessToken', 'token']) {
      // Top-level smuggling fails…
      expect(parseSessionView({ ...view, [key]: 'SENTINEL' }).success).toBe(false);
      // …and per-account smuggling fails too.
      expect(
        parseSessionView({
          ...view,
          accounts: [{ sub: 'u', email: 'u@x.y', [key]: 'SENTINEL' }],
        }).success
      ).toBe(false);
    }
  });

  it('sign-in results: ok, or a typed failure code — never token payloads', () => {
    expect(parseSignInResult({ ok: true }).success).toBe(true);
    expect(parseSignInResult({ ok: false, code: 'NOT_CONFIGURED' }).success).toBe(true);
    expect(
      parseSignInResult({ ok: false, code: 'BROWSER_LAUNCH_FAILED', message: 'no handler' }).success
    ).toBe(true);
    expect(parseSignInResult({ ok: false, code: 'WAT' }).success).toBe(false);
    expect(parseSignInResult({ ok: true, accessToken: 'SENTINEL' }).success).toBe(false);
    expect(parseSignInResult({}).success).toBe(false);
  });

  it('sign-out request: optional per-account sub, nothing else', () => {
    expect(parseSignOutRequest({}).success).toBe(true);
    expect(parseSignOutRequest({ sub: 'user-1' }).success).toBe(true);
    expect(parseSignOutRequest({ sub: '' }).success).toBe(false);
    expect(parseSignOutRequest({ sub: 'user-1', force: true }).success).toBe(false);
  });

  it('switch-org request: a non-empty orgId, nothing else', () => {
    expect(parseSwitchOrgRequest({ orgId: 'org-1' }).success).toBe(true);
    expect(parseSwitchOrgRequest({ orgId: '' }).success).toBe(false);
    expect(parseSwitchOrgRequest({}).success).toBe(false);
    // No `null` on the wire: the renderer only ever switches to a real org.
    expect(parseSwitchOrgRequest({ orgId: null }).success).toBe(false);
    expect(parseSwitchOrgRequest({ orgId: 'org-1', extra: true }).success).toBe(false);
  });

  it('switch-account request: a non-empty sub, nothing else', () => {
    expect(parseSwitchAccountRequest({ sub: 'user-1' }).success).toBe(true);
    expect(parseSwitchAccountRequest({ sub: '' }).success).toBe(false);
    expect(parseSwitchAccountRequest({}).success).toBe(false);
    expect(parseSwitchAccountRequest({ sub: 'user-1', force: true }).success).toBe(false);
  });

  it('session-changed push is exactly the session view', () => {
    expect(parseSessionChangedPush(view).success).toBe(true);
    expect(parseSessionChangedPush({ ...view, idToken: 'SENTINEL' }).success).toBe(false);
  });

  it('collab-token result: a bare string or null, nothing else', () => {
    // The one wire type that legitimately carries a full token.
    expect(parseCollabTokenResult('eyJ.jwt.token').success).toBe(true);
    expect(parseCollabTokenResult(null).success).toBe(true);
    expect(parseCollabTokenResult(123).success).toBe(false);
    expect(parseCollabTokenResult({ token: 'x' }).success).toBe(false);
    expect(parseCollabTokenResult(undefined).success).toBe(false);
  });
});

describe('recording schemas', () => {
  const segment = {
    id: 'tsg_0',
    recordingId: 'rec_1',
    source: 'mic',
    speaker: 'you',
    text: 'hello',
    startTimeMs: 0,
    endTimeMs: 5000,
    segmentOrder: 1_000_000,
  };
  const state = {
    recordingId: 'rec_1',
    finalizingRecordingIds: [],
    completedRecordings: [],
    status: 'recording',
    captureMode: 'mic',
    requestedCaptureMode: 'dual',
    micSource: 'system-default',
    noteId: 'note_1',
    segments: [segment],
    elapsedMs: 5000,
  };

  it('start request: a capture mode, optional noteId/title, nothing else', () => {
    expect(parseStartRecordingRequest({ captureMode: 'dual' }).success).toBe(true);
    expect(
      parseStartRecordingRequest({ captureMode: 'mic', noteId: 'note_1', title: 'T' }).success
    ).toBe(true);
    expect(parseStartRecordingRequest({ captureMode: 'system', noteId: null }).success).toBe(true);
    expect(parseStartRecordingRequest({ captureMode: 'bogus' }).success).toBe(false);
    expect(parseStartRecordingRequest({}).success).toBe(false);
    expect(parseStartRecordingRequest({ captureMode: 'dual', extra: true }).success).toBe(false);
  });

  it('stop request: a non-empty recordingId, nothing else', () => {
    expect(parseStopRecordingRequest({ recordingId: 'rec_1' }).success).toBe(true);
    expect(parseStopRecordingRequest({ recordingId: '' }).success).toBe(false);
    expect(parseStopRecordingRequest({}).success).toBe(false);
    expect(parseStopRecordingRequest({ recordingId: 'rec_1', extra: 1 }).success).toBe(false);
  });

  it('spoken language uses the shared closed enum across Start, update and state', () => {
    for (const language of ['en', 'ja', 'hi', 'zh']) {
      expect(parseStartRecordingRequest({ captureMode: 'mic', language }).success).toBe(true);
      expect(
        recordingLanguageRequestSchema.safeParse({ recordingId: 'rec_1', language }).success
      ).toBe(true);
      expect(parseRecordingStateView({ ...state, language }).success).toBe(true);
    }
    for (const language of ['auto', 'source', 'xx', '', null]) {
      expect(parseStartRecordingRequest({ captureMode: 'mic', language }).success).toBe(false);
      expect(
        recordingLanguageRequestSchema.safeParse({ recordingId: 'rec_1', language }).success
      ).toBe(false);
      expect(parseRecordingStateView({ ...state, language }).success).toBe(false);
    }
    expect(recordingLanguageRequestSchema.safeParse({ recordingId: 'rec_1' }).success).toBe(false);
    expect(
      recordingLanguageRequestSchema.safeParse({ recordingId: '', language: 'en' }).success
    ).toBe(false);
    expect(
      recordingLanguageRequestSchema.safeParse({
        recordingId: 'rec_1',
        language: 'en',
        token: 'secret',
      }).success
    ).toBe(false);
  });

  it('quota baseline crosses Start and state only as a finite, nonnegative value or null', () => {
    for (const quotaRemainingAtStartSeconds of [undefined, null, 0, 600.5]) {
      const request = parseStartRecordingRequest({
        captureMode: 'dual',
        quotaRemainingAtStartSeconds,
      });
      const view = parseRecordingStateView({ ...state, quotaRemainingAtStartSeconds });
      expect(request.success).toBe(true);
      expect(view.success).toBe(true);
      if (request.success)
        expect(request.data.quotaRemainingAtStartSeconds).toBe(quotaRemainingAtStartSeconds);
      if (view.success)
        expect(view.data.quotaRemainingAtStartSeconds).toBe(quotaRemainingAtStartSeconds);
    }
    for (const quotaRemainingAtStartSeconds of [-1, Infinity, NaN, '600']) {
      expect(
        parseStartRecordingRequest({ captureMode: 'dual', quotaRemainingAtStartSeconds }).success
      ).toBe(false);
      expect(parseRecordingStateView({ ...state, quotaRemainingAtStartSeconds }).success).toBe(
        false
      );
    }
  });

  it('pause/resume request uses the same strict recording-id shape', () => {
    expect(parseRecordingControlRequest({ recordingId: 'rec_1' }).success).toBe(true);
    expect(parseRecordingControlRequest({ recordingId: '' }).success).toBe(false);
    expect(parseRecordingControlRequest({ recordingId: 'rec_1', extra: true }).success).toBe(false);
  });

  it('state view: idle, in-flight with segments, and enum-closed status/capture modes', () => {
    expect(
      parseRecordingStateView({
        recordingId: null,
        finalizingRecordingIds: [],
        completedRecordings: [],
        status: 'idle',
        captureMode: null,
        requestedCaptureMode: null,
        micSource: 'system-default',
        noteId: null,
        segments: [],
        elapsedMs: 0,
      }).success
    ).toBe(true);
    expect(parseRecordingStateView(state).success).toBe(true);
    expect(parseRecordingStateView({ ...state, micSource: 'unavailable' }).success).toBe(true);
    expect(parseRecordingStateView({ ...state, status: 'paused' }).success).toBe(true);
    for (const spendsCloudQuota of [true, false, null]) {
      const projected = parseRecordingStateView({ ...state, spendsCloudQuota });
      expect(projected.success).toBe(true);
      if (projected.success) expect(projected.data.spendsCloudQuota).toBe(spendsCloudQuota);
    }
    expect(parseRecordingStateView({ ...state, spendsCloudQuota: 'cloud' }).success).toBe(false);
    expect(parseRecordingStateView({ ...state, captureMode: 'both' }).success).toBe(false);
    expect(parseRecordingStateView({ ...state, micSource: 'unknown' }).success).toBe(false);
    expect(parseRecordingStateView({ ...state, micSource: undefined }).success).toBe(false);
  });

  it('state view is token-free: strict at the top level, strip on segments', () => {
    for (const key of ['token', 'idToken', 'accessToken']) {
      // Top-level state is .strict() — an unexpected key fails the parse.
      expect(parseRecordingStateView({ ...state, [key]: 'SENTINEL' }).success).toBe(false);
      // Segments are .strip() — a token-shaped key is DROPPED (never reaches the
      // renderer) WITHOUT failing the push.
      const parsed = parseRecordingStateView({
        ...state,
        segments: [{ ...segment, [key]: 'SENTINEL' }],
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect((parsed.data.segments[0] as Record<string, unknown>)[key]).toBeUndefined();
      }
    }
  });

  it('server transcript segments with extra metadata strip cleanly', () => {
    // The real transcribe lane returns transcript_segment rows carrying
    // createdAt/updatedAt/orgUserId/isFinal/deletedAt — these MUST strip, not
    // fail the whole live-transcript state push (which silently lost the UI
    // transcript in the smoke).
    const serverSegment = {
      ...segment,
      createdAt: '2026-07-12T00:00:00Z',
      updatedAt: '2026-07-12T00:00:01Z',
      orgUserId: 'ou_1',
      isFinal: true,
      deletedAt: null,
    };
    const parsed = parseRecordingStateView({ ...state, segments: [serverSegment] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data.segments[0]).sort()).toEqual(
        [
          'endTimeMs',
          'id',
          'recordingId',
          'segmentOrder',
          'source',
          'speaker',
          'startTimeMs',
          'text',
        ].sort()
      );
    }
  });

  it('e2e command: push a state, or force the next start result, nothing else', () => {
    expect(parseRecordingE2ECommand({ kind: 'push', view: state }).success).toBe(true);
    expect(
      parseRecordingE2ECommand({ kind: 'forceStart', result: { ok: true, recordingId: 'rec_1' } })
        .success
    ).toBe(true);
    expect(
      parseRecordingE2ECommand({
        kind: 'forceStart',
        result: { ok: false, reason: 'permission-denied' },
      }).success
    ).toBe(true);
    expect(
      parseRecordingE2ECommand({ kind: 'forceStart', result: { ok: false, reason: 'nope' } })
        .success
    ).toBe(false);
    expect(parseRecordingE2ECommand({ kind: 'evil' }).success).toBe(false);
  });
});

describe('local models', () => {
  const model = {
    id: 'whisper-base-en',
    name: 'Whisper Base (English)',
    filename: 'ggml-base.en.bin',
    sizeBytes: 147_964_211,
    kind: 'whisper',
    recommended: true,
    installed: false,
    installedAt: null,
    download: null,
  };

  it('parses a strict model request (id only)', () => {
    expect(parseModelRequest({ modelId: 'whisper-base-en' }).success).toBe(true);
    expect(parseModelRequest({}).success).toBe(false);
    expect(parseModelRequest({ modelId: '' }).success).toBe(false);
    expect(parseModelRequest({ modelId: 'x', extra: true }).success).toBe(false);
    expect(parseModelRequest('whisper-base-en').success).toBe(false);
  });

  it('parses the state snapshot and strips unknown fields (no URL ever crosses)', () => {
    const idle = parseModelsStateView({ models: [model], modelsDir: '/models' });
    expect(idle.success).toBe(true);
    const downloading = parseModelsStateView({
      models: [
        {
          ...model,
          downloadUrl: 'https://huggingface.co/x',
          download: { status: 'downloading', bytesDownloaded: 10, totalBytes: 100, error: null },
        },
      ],
      modelsDir: '/models',
    });
    expect(downloading.success).toBe(true);
    if (downloading.success) {
      expect(JSON.stringify(downloading.data)).not.toContain('huggingface');
      expect(downloading.data.models[0]?.download?.status).toBe('downloading');
    }
    const errored = parseModelsStateView({
      models: [
        {
          ...model,
          download: {
            status: 'error',
            bytesDownloaded: 0,
            totalBytes: 100,
            error: 'checksum-mismatch',
          },
        },
      ],
      modelsDir: '/models',
    });
    expect(errored.success).toBe(true);
  });

  it('rejects malformed snapshots (bad kind, open error set, non-integer size)', () => {
    expect(
      parseModelsStateView({ models: [{ ...model, kind: 'tts' }], modelsDir: '/m' }).success
    ).toBe(false);
    expect(
      parseModelsStateView({
        models: [
          {
            ...model,
            download: { status: 'error', bytesDownloaded: 0, totalBytes: 1, error: 'boom' },
          },
        ],
        modelsDir: '/m',
      }).success
    ).toBe(false);
    expect(
      parseModelsStateView({ models: [{ ...model, sizeBytes: 1.5 }], modelsDir: '/m' }).success
    ).toBe(false);
    expect(parseModelsStateView({ models: [model] }).success).toBe(false);
  });

  it('the renderer mirror (app-contracts LocalModelsState) accepts the wire view field-for-field', () => {
    // Same discipline as DeviceSettings: the plain-TS renderer shape must stay
    // assignable from the zod wire view, so a drift in either fails to compile.
    const toRenderer = (view: ModelsStateView): LocalModelsState => view;
    const parsed = parseModelsStateView({
      models: [
        {
          ...model,
          download: { status: 'downloading', bytesDownloaded: 10, totalBytes: 100, error: null },
        },
      ],
      modelsDir: '/models',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(toRenderer(parsed.data)).toEqual(parsed.data);
  });
});

describe('transcription BYOK key request', () => {
  it('binds a non-empty key to its endpoint in one strict payload', () => {
    const baseUrl = 'https://transcription.test/v1';
    expect(parseTranscriptionByokKeyRequest({ key: 'sk-test', baseUrl })).toEqual({
      success: true,
      data: { key: 'sk-test', baseUrl },
    });
    expect(parseTranscriptionByokKeyRequest({ key: '', baseUrl }).success).toBe(false);
    expect(parseTranscriptionByokKeyRequest({ key: 'sk-test' }).success).toBe(false);
    expect(parseTranscriptionByokKeyRequest({ key: 'sk-test', baseUrl: ' ' }).success).toBe(false);
    expect(parseTranscriptionByokKeyRequest({ key: 'sk-test', baseUrl, extra: 1 }).success).toBe(
      false
    );
    expect(parseTranscriptionByokKeyRequest({}).success).toBe(false);
    expect(parseTranscriptionByokKeyRequest('sk-test').success).toBe(false);
  });
});

describe('AI provider key and catalogue requests', () => {
  it('pin the provider kind and a non-empty key, nothing else', () => {
    expect(parseAiProviderKeyRequest({ provider: 'anthropic', key: 'sk-ant' })).toEqual({
      success: true,
      data: { provider: 'anthropic', key: 'sk-ant' },
    });
    expect(parseAiProviderKeyRequest({ provider: 'anthropic', key: '' }).success).toBe(false);
    expect(parseAiProviderKeyRequest({ provider: 'groq', key: 'k' }).success).toBe(false);
    expect(parseAiProviderKeyRequest({ provider: 'openai', key: 'k', extra: 1 }).success).toBe(
      false
    );
    expect(parseAiProviderRequest({ provider: 'ollama' })).toEqual({
      success: true,
      data: { provider: 'ollama' },
    });
    expect(parseAiProviderRequest({ provider: 'mock' }).success).toBe(false);
    expect(parseAiProviderRequest({}).success).toBe(false);
  });
  it('the listing request takes an optional force flag and nothing else', () => {
    expect(parseAiModelListRequest({ provider: 'ollama' })).toEqual({
      success: true,
      data: { provider: 'ollama' },
    });
    expect(parseAiModelListRequest({ provider: 'ollama', force: true }).success).toBe(true);
    expect(parseAiModelListRequest({ provider: 'ollama', force: 'yes' }).success).toBe(false);
    expect(parseAiModelListRequest({ provider: 'ollama', extra: 1 }).success).toBe(false);
  });
  it('listing results carry an array plus a nullable closed-set reason', () => {
    expect(parseAiModelListing({ models: ['a'], error: null }).success).toBe(true);
    expect(parseAiModelListing({ models: [], error: 'network' }).success).toBe(true);
    expect(parseAiModelListing({ models: [], error: 'weird' }).success).toBe(false);
    expect(parseAiModelListing({ error: null }).success).toBe(false);
  });
});

describe('channel names', () => {
  it('are stable (renderer + main both compile against these)', () => {
    expect(CHANNELS).toEqual({
      envGet: 'env:get',
      transportRequest: 'transport:request',
      transportOpenStream: 'transport:openStream',
      collabOpen: 'collab:open',
      navPush: 'nav:push',
      floatOpen: 'float:open',
      floatCollapse: 'float:collapse',
      floatDockBack: 'float:dockBack',
      floatStateChanged: 'float:state',
      e2eStreamStats: 'e2e:streamStats',
      e2eAuthPendingState: 'e2e:authPendingState',
      e2eAuthAuthorizeUrl: 'e2e:authAuthorizeUrl',
      e2eSessionProbe: 'e2e:sessionProbe',
      authGetSession: 'auth:getSession',
      authSignIn: 'auth:signIn',
      authOpenWebSession: 'auth:openWebSession',
      authSignOut: 'auth:signOut',
      authSwitchOrg: 'auth:switchOrg',
      authSwitchAccount: 'auth:switchAccount',
      authGetCollabToken: 'auth:getCollabToken',
      authSessionChanged: 'auth:sessionChanged',
      recordingStart: 'recording:start',
      recordingStop: 'recording:stop',
      recordingClaimCompletion: 'recording:claimCompletion',
      recordingSetSkillWorkflow: 'recording:setSkillWorkflow',
      recordingPause: 'recording:pause',
      recordingSetLanguage: 'recording:setLanguage',
      recordingResume: 'recording:resume',
      recordingStateChanged: 'recording:stateChanged',
      settingsGet: 'settings:get',
      settingsSet: 'settings:set',
      settingsChanged: 'settings:changed',
      loggingGetConfig: 'logging:getConfig',
      loggingWrite: 'logging:write',
      telemetryGetState: 'telemetry:getState',
      telemetryStateChanged: 'telemetry:stateChanged',
      telemetryCapture: 'telemetry:capture',
      telemetryIdentifyPlan: 'telemetry:identifyPlan',
      telemetryCaptureException: 'telemetry:captureException',
      modelsGetState: 'models:getState',
      modelsDownload: 'models:download',
      modelsCancelDownload: 'models:cancelDownload',
      modelsDelete: 'models:delete',
      modelsStateChanged: 'models:stateChanged',
      capabilityCheckUpdates: 'capability:checkUpdates',
      updaterGetAccess: 'updater:getAccess',
      updaterAccessChanged: 'updater:accessChanged',
      updaterOpenDownload: 'updater:openDownload',
      updaterQuit: 'updater:quit',
      updaterGetState: 'updater:getState',
      updaterStateChanged: 'updater:stateChanged',
      updaterQuitInstall: 'updater:quitInstall',
      updaterDismissPrompt: 'updater:dismissPrompt',
      capabilityExportLogs: 'capability:exportLogs',
      capabilityRestartApp: 'capability:restartApp',
      capabilityResetApp: 'capability:resetApp',
      capabilityGetAppModeState: 'capability:getAppModeState',
      capabilityChooseAppMode: 'capability:chooseAppMode',
      capabilityGetPermissions: 'capability:getPermissions',
      capabilityRequestPermission: 'capability:requestPermission',
      capabilityOpenSystemSettings: 'capability:openSystemSettings',
      capabilityGetAppleCalendarStatus: 'capability:getAppleCalendarStatus',
      capabilityEnableAppleCalendar: 'capability:enableAppleCalendar',
      capabilityRefreshAppleCalendar: 'capability:refreshAppleCalendar',
      capabilitySetTranscriptionByokKey: 'capability:setTranscriptionByokKey',
      capabilityClearTranscriptionByokKey: 'capability:clearTranscriptionByokKey',
      capabilityHasTranscriptionByokKey: 'capability:hasTranscriptionByokKey',
      capabilitySetAiProviderKey: 'capability:setAiProviderKey',
      capabilityClearAiProviderKey: 'capability:clearAiProviderKey',
      capabilityHasAiProviderKey: 'capability:hasAiProviderKey',
      capabilityListAiModels: 'capability:listAiModels',
      themeSetSource: 'theme:setSource',
      e2eRecording: 'e2e:recording',
    });
    expect(streamPortChannel('abc')).toBe('transport:stream:abc');
  });
});
