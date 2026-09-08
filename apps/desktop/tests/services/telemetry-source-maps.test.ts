import { describe, expect, it } from 'vitest';
import { getPostHogSourceMapOptions } from '../../vite.posthog';

describe('source-map build configuration', () => {
  it('does not upload by default; an explicit upload requires all build credentials', () => {
    expect(getPostHogSourceMapOptions({})).toBeUndefined();
    expect(() => getPostHogSourceMapOptions({ POSTHOG_SOURCE_MAP_UPLOAD: 'true' })).toThrow(
      'requires'
    );
  });
  it('uses a version+revision release and removes uploaded maps', () => {
    const options = getPostHogSourceMapOptions({
      POSTHOG_SOURCE_MAP_UPLOAD: 'true',
      POSTHOG_PERSONAL_API_KEY: 'test-only',
      POSTHOG_PROJECT_ID: '123',
      POSTHOG_RELEASE_SHA: 'abcdef',
    });
    expect(options?.sourcemaps).toMatchObject({
      releaseName: 'prismical-desktop',
      releaseVersion: expect.stringMatching(/\+abcdef$/),
      deleteAfterUpload: true,
    });
  });
});
