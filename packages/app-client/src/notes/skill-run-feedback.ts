import { toast } from 'sonner';

// The rendered Ask conversation registers the runs it can actually explain.
// Hidden panels and other conversations never suppress the dock fallback.
const surfaces = new Map<symbol, ReadonlySet<string>>();
export function registerSkillFeedbackSurface(ids: readonly string[]) {
  const key = Symbol();
  surfaces.set(key, new Set(ids));
  ids.forEach(id => toast.dismiss(`skill-feedback-${id}`));
  return () => { surfaces.delete(key); };
}
export function skillRunFeedback(runId: string | null) {
  const send = (kind: 'error' | 'warning' | 'info', args: Parameters<typeof toast.error>) => {
    if (runId && [...surfaces.values()].some(ids => ids.has(runId))) return;
    return toast[kind](args[0], { ...args[1], ...(runId ? { id: `skill-feedback-${runId}` } : {}) });
  };
  return {
    error: (...args: Parameters<typeof toast.error>) => send('error', args),
    warning: (...args: Parameters<typeof toast.warning>) => send('warning', args),
    info: (...args: Parameters<typeof toast.info>) => send('info', args),
  };
}
