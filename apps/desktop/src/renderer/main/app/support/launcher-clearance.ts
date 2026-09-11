import { useEffect } from 'react';

type Bounds = { left: number; right: number; top: number; bottom: number };

export function launcherOverlapsDock(launcher: Bounds, obstacles: Bounds[]) {
  return obstacles.some(obstacle =>
    obstacle.right > obstacle.left && obstacle.bottom > obstacle.top &&
    launcher.left < obstacle.right + 12 && launcher.right > obstacle.left - 12 &&
    launcher.top < obstacle.bottom + 12 && launcher.bottom > obstacle.top - 12
  );
}

/** Share the dock's obstacle markers with toast placement, including expanded panels. */
export function useLauncherClearance(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    let observed: Element[] = [];
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const measure = () => {
      const launcher = document.querySelector('.bb-feedback-button');
      const obstacles = [...document.querySelectorAll('[data-toast-obstacle]')];
      const targets = [document.body, ...obstacles, ...obstacles.flatMap(el => el.parentElement ? [el.parentElement] : []), ...(launcher ? [launcher] : [])];
      if (targets.length !== observed.length || targets.some((el, i) => el !== observed[i])) {
        resize.disconnect();
        targets.forEach(el => resize.observe(el));
        observed = targets;
      }
      document.documentElement.toggleAttribute('data-support-launcher-obstructed', !!launcher &&
        launcherOverlapsDock(launcher.getBoundingClientRect(), obstacles.map(el => el.getBoundingClientRect())));
    };
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
      document.documentElement.removeAttribute('data-support-launcher-obstructed');
    };
  }, [enabled]);
}
