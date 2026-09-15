// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { ACCOUNT_EXPERIENCE_DEFAULTS } from '@prismical/api-contracts/apps/v1';
import {
  AccountExperienceStore,
  bindAccountExperience,
} from '../settings/account-experience-store';
import { getAutoEnhanceEnabled, setAutoEnhanceEnabled } from './auto-enhance-setting';
it('uses the loaded account value and clears it on a session switch', async () => {
  const defaults = structuredClone(ACCOUNT_EXPERIENCE_DEFAULTS);
  const response = { ...defaults, language: null, transcription: null };
  const store = new AccountExperienceStore('user', {
    get: async () => response,
    patch: async () => {
      throw new Error('offline');
    },
  });
  const unbind = bindAccountExperience(store);
  try {
    expect(getAutoEnhanceEnabled()).toBe(false);
    await store.refresh();
    expect(getAutoEnhanceEnabled()).toBe(true);
    setAutoEnhanceEnabled(false);
    expect(getAutoEnhanceEnabled()).toBe(false);
  } finally {
    store.dispose();
    unbind();
  }
  expect(getAutoEnhanceEnabled()).toBe(false);
});
