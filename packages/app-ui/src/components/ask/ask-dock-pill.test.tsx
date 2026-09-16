// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AskPillFace } from './ask-dock-pill';
import { findTourAnchor } from '../../onboarding/anchored-tour';
import { Loader } from '../ai-elements/loader';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@prismical/app-client', () => ({
  useEntitlements: () => ({ entitlements: { features: { askAi: true } } }),
  useSkillsList: () => ({ data: [] }),
  useSkillDiffStore: (select: (state: { candidatesByNote: Map<string, unknown> }) => unknown) => select({ candidatesByNote: new Map() }),
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('keeps the collapsed running face reachable by the tour and Stop separate from opening Ask', () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const cancel = vi.fn();
  const open = vi.fn();
  const { container } = render(<>
    <div style={{ visibility: 'hidden' }}><Loader /></div>
    <AskPillFace onClick={open} noteId="note" activeRun={{ id: 'run', noteId: 'note', skillId: 'cleanup', skillName: 'Cleanup', source: 'chip', status: 'running', startedAt: 1, cancel }} />
  </>);
  expect(findTourAnchor('enhance')).toBe(container.querySelector('[data-skill-run="running"]'));
  const clips = Array.from(container.querySelectorAll('clipPath'));
  expect(new Set(clips.map(clip => clip.id)).size).toBe(2);
  for (const clip of clips) {
    expect(clip.closest('svg')?.querySelector('g')?.getAttribute('clip-path')).toBe(`url(#${clip.id})`);
  }
  fireEvent.click(screen.getByRole('button', { name: 'ask.skillRun.stop' }));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'ask.title' }));
  expect(open).toHaveBeenCalledTimes(1);
});
