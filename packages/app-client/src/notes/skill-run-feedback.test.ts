import { afterEach, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { registerSkillFeedbackSurface, skillRunFeedback } from './skill-run-feedback';
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => vi.clearAllMocks());
it('suppresses only the run explained by an open surface and restores fallback when it closes', () => {
  const close = registerSkillFeedbackSurface(['visible']);
  skillRunFeedback('visible').error('Offline');
  expect(toast.error).not.toHaveBeenCalled();
  skillRunFeedback('other').error('Offline');
  expect(toast.error).toHaveBeenCalledWith('Offline', { id: 'skill-feedback-other' });
  close();
  skillRunFeedback('visible').error('Offline');
  expect(toast.error).toHaveBeenLastCalledWith('Offline', { id: 'skill-feedback-visible' });
});
it('dismisses the fallback when the same run is opened and keeps untracked errors', () => {
  const close = registerSkillFeedbackSurface(['run']);
  expect(toast.dismiss).toHaveBeenCalledWith('skill-feedback-run');
  skillRunFeedback(null).error('Title conflict');
  expect(toast.error).toHaveBeenCalledWith('Title conflict', {});
  close();
});
