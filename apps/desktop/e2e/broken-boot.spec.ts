import { test, expect } from '@playwright/test';
import { launchPrismical } from './helpers/launch';

// Harness honesty gate: a boot failure must FAIL the suite. boot.ts
// throws at module evaluation under PRISMICAL_E2E_BREAK_BOOT=1 and entry.ts's
// fatal boundary exits non-zero, so the launch never yields an app — Playwright
// rejects instead of handing back a half-initialized instance. If this spec
// ever passes with a window on screen, someone added a catch-and-continue.
test.describe('broken boot', () => {
  test('a deliberately broken boot fails the launch', async () => {
    await expect(launchPrismical({ PRISMICAL_E2E_BREAK_BOOT: '1' })).rejects.toThrow();
  });
});
