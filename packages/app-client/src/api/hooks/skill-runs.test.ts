import { beforeEach, describe, expect, it, vi } from 'vitest';
const http = vi.hoisted(() => ({ post: vi.fn(), postRaw: vi.fn(), getRaw: vi.fn() }));
vi.mock('../client', () => ({ apiClient: http, ME_PREFIX: '/apps/v1/me' }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { mutationFn: unknown }) => ({ mutateAsync: options.mutationFn }),
}));
import {
  listPendingSkillResults,
  resolvePendingSkillResult,
  runSkillRequest,
  useAcceptArtifact,
} from './skill-runs';
const result = {
  mode: 'replace-doc',
  skillId: 'skill',
  skillName: 'Summary',
  modelId: 'model',
  rawMarkdown: 'Saved output',
  reasoning: null,
};
const receipt = { artifactId: 'artifact', version: 1, generatedAt: '2026-09-14T00:00:00.000Z' };
const accept = {
  noteId: 'note',
  skillId: 'skill',
  mode: 'replace-doc' as const,
  content: '[]',
  rawMarkdown: 'Saved output',
};
beforeEach(() => {
  vi.resetAllMocks();
  http.post.mockResolvedValue(result);
  http.postRaw.mockResolvedValue(receipt);
  http.getRaw.mockResolvedValue({ results: [] });
});
describe('skill protocol routing', () => {
  it('keeps requests without durable context on the legacy route', async () => {
    await runSkillRequest('skill', { noteId: 'note', recordingId: 'recording', recoverable: true });
    expect(http.post).toHaveBeenCalledWith(
      '/apps/v1/me/skills/skill/run',
      { noteId: 'note', recordingId: 'recording', recoverable: true },
      expect.anything()
    );
    await useAcceptArtifact().mutateAsync(accept);
    expect(http.postRaw).toHaveBeenCalledWith('/apps/v1/me/skill-runs/accept', accept);
  });
  it('uses durable routes for generation, discovery, acceptance and resolution', async () => {
    const body = { noteId: 'note', recoveryContext: { baseContent: '{}' } };
    await runSkillRequest('skill', body);
    expect(http.post).toHaveBeenCalledWith(
      '/apps/v1/me/skills/skill/run/durable',
      body,
      expect.anything()
    );
    await listPendingSkillResults('note');
    expect(http.getRaw).toHaveBeenCalledWith(
      '/apps/v1/me/skill-runs/pending/durable',
      { noteId: 'note' },
      expect.anything()
    );
    await useAcceptArtifact().mutateAsync({ ...accept, durable: true });
    expect(http.postRaw).toHaveBeenCalledWith('/apps/v1/me/skill-runs/accept/durable', accept);
    await resolvePendingSkillResult('note', 'result', { durable: true, discardAccepted: true });
    expect(http.postRaw).toHaveBeenLastCalledWith('/apps/v1/me/skill-runs/resolve/durable', {
      noteId: 'note',
      resultId: 'result',
      discardAccepted: true,
    });
  });
  it('never falls back to legacy acceptance after a durable request fails', async () => {
    http.postRaw.mockRejectedValue(new Error('Unavailable'));
    await expect(useAcceptArtifact().mutateAsync({ ...accept, durable: true })).rejects.toThrow(
      'Unavailable'
    );
    expect(http.postRaw).toHaveBeenCalledTimes(1);
    expect(http.postRaw).toHaveBeenCalledWith('/apps/v1/me/skill-runs/accept/durable', accept);
  });
});
