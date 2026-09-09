import * as React from 'react';

type Bounds = { left: number; right: number; top: number; bottom: number };

export function toastDockClearance(
  viewportHeight: number,
  toast: Pick<Bounds, 'left' | 'right'>,
  obstacles: Bounds[]
) {
  return obstacles.reduce((bottom, obstacle) => {
    const overlaps = toast.left < obstacle.right + 12 && toast.right > obstacle.left - 12;
    if (!overlaps || obstacle.right <= obstacle.left || obstacle.bottom <= obstacle.top)
      return bottom;
    return Math.max(bottom, viewportHeight - obstacle.top + 12);
  }, 16);
}

/** Measure the visible dock, including panel morphs and sidebar/window resizing. */
export function useToastDockClearance(ref: React.RefObject<HTMLDivElement | null>) {
  React.useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let frame = 0;
    let observed: Element[] = [];
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const measure = () => {
      const toaster = host.querySelector<HTMLElement>('[data-sonner-toaster]');
      if (!toaster) return;
      const obstacles = [...document.querySelectorAll<HTMLElement>('[data-toast-obstacle]')];
      const toasts = [...toaster.querySelectorAll<HTMLElement>('[data-sonner-toast]')];
      const targets = [toaster, ...toasts, ...obstacles, ...obstacles.map(el => el.parentElement!)];
      if (targets.length !== observed.length || targets.some((el, i) => el !== observed[i])) {
        resize.disconnect();
        targets.forEach(el => resize.observe(el));
        observed = targets;
      }
      // Sonner's mobile container is 100vw wide but its toast cards have side margins.
      const cards = toasts.length
        ? toasts.map(el => el.getBoundingClientRect())
        : [toaster.getBoundingClientRect()];
      const left = Math.min(...cards.map(rect => rect.left));
      const right = Math.min(window.innerWidth - 16, Math.max(...cards.map(rect => rect.right)));
      const bottom = toastDockClearance(
        window.innerHeight,
        { left, right },
        obstacles.map(el => el.getBoundingClientRect())
      );
      host.style.setProperty('--toast-dock-bottom', `${bottom}px`);
    };
    // The dock mounts after auth and disappears on routes outside the app shell.
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-toast-obstacle'],
    });
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [ref]);
}
