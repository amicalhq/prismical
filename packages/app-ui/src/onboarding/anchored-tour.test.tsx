// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { AnchoredTour, findTourAnchor } from './anchored-tour';
const mock = vi.hoisted(() => ({ highlight: vi.fn(), destroy: vi.fn(), driver: vi.fn() }));
vi.mock('driver.js', () => ({ driver: mock.driver.mockReturnValue(mock) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
function anchor(name: string) {
  const element = document.createElement('button');
  element.dataset.onboarding = name;
  vi.spyOn(element, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  document.body.append(element);
  return element;
}
it('ignores hidden duplicate targets and prefers the expanded recording control', () => {
  const hidden = anchor('record-start');
  hidden.setAttribute('aria-hidden', 'true');
  const expanded = anchor('record-start');
  anchor('record-open');
  expect(findTourAnchor('record')).toBe(expanded);
});
it('keeps action targets interactive, respects reduced motion, and exits with Escape', async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true }))
  );
  const target = anchor('new-note');
  const onContinue = vi.fn();
  const onExit = vi.fn();
  const view = render(<AnchoredTour step="create" onContinue={onContinue} onExit={onExit} />);
  await waitFor(() => expect(mock.highlight).toHaveBeenCalled());
  expect(mock.driver).toHaveBeenCalledWith(
    expect.objectContaining({ animate: false, disableActiveInteraction: false })
  );
  expect(mock.highlight).toHaveBeenCalledWith(
    expect.objectContaining({
      element: target,
      popover: expect.objectContaining({ showButtons: ['close'] }),
    })
  );
  target.click();
  expect(onContinue).not.toHaveBeenCalled();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(onExit).toHaveBeenCalledOnce();
  view.unmount();
  expect(mock.destroy).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});
