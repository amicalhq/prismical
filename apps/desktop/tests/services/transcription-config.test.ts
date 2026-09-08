import { assert, describe, it } from '@effect/vitest';
import type { TransportResponse } from '@prismical/desktop-contracts';
import { Effect } from 'effect';
import { makeFakeWorkspaceBackend } from '../helpers/fake-recording';
import { resolveTranscriptionConfig } from '../../src/main/domains/transcriber/transcription-config';
import {
  transcriptionConfigFor,
  type RecordingEngine,
} from '../../src/main/domains/transcriber/engine';
import { MANAGED_TRANSCRIPTION_CONFIG } from '../../src/main/domains/transport/live';
import { WorkspaceBackend } from '../../src/main/domains/transport/service';

const CLOUD: RecordingEngine = {
  engine: 'cloud',
  modelId: 'whisper-base-en',
  byokBaseUrl: null,
  byokModel: null,
};

describe('recording transcription configuration', () => {
  it.effect('uses managed transcription when defaults are absent, invalid, or unavailable', () =>
    Effect.gen(function* () {
      const fake = makeFakeWorkspaceBackend();
      const backend = yield* WorkspaceBackend.pipe(Effect.provide(fake.layer));
      const responses: TransportResponse[] = [
        { error: { code: 'INTERNAL' } },
        { ok: true, status: 503, bodyJson: {} },
        { ok: true, status: 200, bodyJson: {} },
        { ok: true, status: 200, bodyJson: { formatting: null, transcription: null } },
        {
          ok: true,
          status: 200,
          bodyJson: { formatting: null, transcription: { instanceId: 'inst_1', modelId: null } },
        },
      ];
      for (const response of responses) {
        fake.setRequestResponder(() => response);
        assert.deepStrictEqual(
          yield* resolveTranscriptionConfig(CLOUD, backend),
          MANAGED_TRANSCRIPTION_CONFIG
        );
      }
    })
  );

  it.effect('keeps local and device-BYOK configuration without requesting server defaults', () =>
    Effect.gen(function* () {
      const fake = makeFakeWorkspaceBackend();
      const backend = yield* WorkspaceBackend.pipe(Effect.provide(fake.layer));
      for (const engine of ['local', 'byok'] as const) {
        const selected = { ...CLOUD, engine };
        assert.deepStrictEqual(
          yield* resolveTranscriptionConfig(selected, backend),
          transcriptionConfigFor(selected)
        );
      }
      assert.deepStrictEqual(fake.requestCalls, []);
    })
  );
});
