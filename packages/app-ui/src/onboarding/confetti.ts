// Uses the lightweight canvas-confetti API demonstrated by Magic UI:
// https://magicui.design/docs/components/confetti
export async function celebrateOnboarding(isCurrent: () => boolean): Promise<void> {
  let canvas: HTMLCanvasElement | undefined;
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const { default: confetti } = await import('canvas-confetti');
    if (!isCurrent() || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:100';
    document.body.append(canvas);
    await confetti.create(canvas, { resize: true })({
      particleCount: 65,
      spread: 65,
      origin: { y: 0.65 },
      ticks: 120,
      disableForReducedMotion: true,
    });
  } catch {
    /* A decoration must never affect a successful Keep. */
  } finally {
    canvas?.remove();
  }
}
