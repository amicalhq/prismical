// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const burst = vi.hoisted(() => vi.fn());
vi.mock('canvas-confetti', () => ({ default: { create: () => burst } }));
import { celebrateOnboarding } from './confetti';
beforeEach(() => {
  burst.mockClear();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
});
it('fires one bounded burst with reduced motion protection', async () => {
  await celebrateOnboarding(() => true);
  expect(burst).toHaveBeenCalledTimes(1);
  expect(document.querySelector('canvas')).toBeNull();
  expect(burst).toHaveBeenCalledWith(
    expect.objectContaining({ disableForReducedMotion: true, ticks: 120, particleCount: 65 })
  );
});
it('never fires with reduced motion or after leaving the account', async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
  await celebrateOnboarding(() => true);
  expect(burst).not.toHaveBeenCalled();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  await celebrateOnboarding(() => false);
  expect(burst).not.toHaveBeenCalled();
});
