/**
 * Desktop managed-provider disclosure guard.
 *
 * `MANAGED_TRANSCRIPTION_CONFIG` is sent on every managed recording create and stored verbatim by
 * the server, so anything named there is both compiled into a shipped desktop build and echoed back
 * on every recording read. Which engine Prismical Cloud routes to is a server-side decision and is
 * not disclosed.
 *
 * Asserted against the constant rather than the source text on purpose: the same model names appear
 * legitimately elsewhere for LOCAL, on-device Whisper builds the user downloads and picks.
 */
import { describe, expect, it } from 'vitest';
import { MANAGED_TRANSCRIPTION_CONFIG } from '../../src/main/domains/transport/live';

describe('managed transcription config', () => {
  it('contains only the public managed transcription configuration', () => {
    expect(MANAGED_TRANSCRIPTION_CONFIG).toStrictEqual({
      provider: 'prismical-cloud',
      model: 'prismical-cloud',
      language: 'en',
    });
  });
});
