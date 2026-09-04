/**
 * The local feature-flag table must answer every cloud-only
 * key app-client defaults to TRUE for a cloud org — otherwise a new cloud-only
 * surface would be gated on a key the local resolver never heard of and read
 * `?? false` by accident rather than by decision.
 */
import { describe, expect, it } from 'vitest';
import { CLOUD_FEATURE_DEFAULTS } from '@prismical/app-client';
import { LOCAL_FEATURE_FLAGS } from '@prismical/desktop-contracts';

describe('LOCAL_FEATURE_FLAGS', () => {
  it('names every key CLOUD_FEATURE_DEFAULTS defaults for a cloud org', () => {
    const missing = Object.keys(CLOUD_FEATURE_DEFAULTS).filter(
      key => !(key in LOCAL_FEATURE_FLAGS)
    );
    expect(missing).toEqual([]);
  });

  it('answers every cloud-only key false; auto-pause is the one on-device true', () => {
    for (const key of Object.keys(CLOUD_FEATURE_DEFAULTS)) {
      expect(LOCAL_FEATURE_FLAGS[key], key).toBe(false);
    }
    expect(LOCAL_FEATURE_FLAGS.autoPauseOnSilence).toBe(true);
    // The server-registered operational flags stay off locally too.
    expect(LOCAL_FEATURE_FLAGS.integrations).toBe(false);
    expect(LOCAL_FEATURE_FLAGS.eventkitCalendar).toBe(false);
  });
});
