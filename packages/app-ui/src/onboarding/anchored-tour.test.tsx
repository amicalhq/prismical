// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { AnchoredTour, findTourAnchor } from './anchored-tour';
const mock = vi.hoisted(() => ({
  highlight: vi.fn(),
  refresh: vi.fn(),
  destroy: vi.fn(),
  driver: vi.fn(),
}));
vi.mock('driver.js', () => ({ driver: mock.driver.mockReturnValue(mock) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

async function showRecordTour() {
  mock.driver.mockReturnValue(mock);
  vi.useFakeTimers();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true }))
  );
  const target = anchor('record-start');
  const onError = vi.fn();
  const onExit = vi.fn();
  const view = render(
    <AnchoredTour step="record" onContinue={vi.fn()} onExit={onExit} onError={onError} />
  );
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(mock.highlight).toHaveBeenLastCalledWith(expect.objectContaining({ element: target }));
  return { target, onError, onExit, view };
}

it('allows a full grace period after a long-visible target disappears, then recovers', async () => {
  const { target, onError } = await showRecordTour();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  target.remove();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  expect(onError).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(onError).toHaveBeenCalledExactlyOnceWith('target_unavailable');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(onError).toHaveBeenCalledTimes(1);
  const retry = anchor('record-start');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(mock.highlight).toHaveBeenLastCalledWith(expect.objectContaining({ element: retry }));
});

it('guides slow microphone startup without completing the record step and permits dismissal', async () => {
  const { target, onError, onExit } = await showRecordTour();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  target.remove();
  const pending = anchor('record-pending');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(onError).not.toHaveBeenCalled();
  expect(mock.highlight).toHaveBeenLastCalledWith(
    expect.objectContaining({
      element: pending,
      popover: expect.objectContaining({
        title: 'onboarding.tour.starting.title',
        description: 'onboarding.tour.starting.body',
        showButtons: ['close'],
      }),
    })
  );
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(onExit).toHaveBeenCalledOnce();
});

it('returns to Start after failed setup and follows confirmed capture through Stop', async () => {
  const { target, onError, onExit, view } = await showRecordTour();
  target.remove();
  const pending = anchor('record-pending');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  pending.remove();
  const retry = anchor('record-start');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(mock.highlight).toHaveBeenLastCalledWith(
    expect.objectContaining({
      element: retry,
      popover: expect.objectContaining({ title: 'onboarding.tour.record.title' }),
    })
  );
  retry.remove();
  const transcript = anchor('transcript');
  view.rerender(
    <AnchoredTour step="speak" onContinue={vi.fn()} onExit={onExit} onError={onError} />
  );
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(mock.highlight).toHaveBeenLastCalledWith(expect.objectContaining({ element: transcript }));
  const stop = anchor('record-stop');
  view.rerender(
    <AnchoredTour step="stop" onContinue={vi.fn()} onExit={onExit} onError={onError} />
  );
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(mock.highlight).toHaveBeenLastCalledWith(expect.objectContaining({ element: stop }));
  expect(onError).not.toHaveBeenCalled();
});

it('uses the newest visible skill status after a retry', () => {
  anchor('skill-status');
  const newest = anchor('skill-status');
  const hidden = anchor('skill-status');
  hidden.setAttribute('inert', '');
  expect(findTourAnchor('enhance')).toBe(newest);
});
it.each([
  ['transcript', 'transcript-wait', 'waiting'],
  ['enhance', 'transcript-wait', 'waiting'],
  ['enhance', 'skill-status', 'generating'],
  ['transcript', 'record-retry', 'retry'],
  ['speak', 'record-open', 'retry'],
  ['stop', 'record-saving', 'waiting'],
] as const)('guides %s through %s without false completion', async (step, name, presentation) => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true }))
  );
  mock.driver.mockReturnValue(mock);
  const target = anchor(name);
  const onError = vi.fn();
  render(<AnchoredTour step={step} onContinue={vi.fn()} onExit={vi.fn()} onError={onError} />);
  await waitFor(() =>
    expect(mock.highlight).toHaveBeenCalledWith(
      expect.objectContaining({
        element: target,
        popover: expect.objectContaining({
          title: `onboarding.tour.${presentation}.title`,
          showButtons: ['close'],
        }),
      })
    )
  );
  expect(onError).not.toHaveBeenCalled();
});

it('refreshes geometry when the current dock target moves without stealing focus', async () => {
  const { target } = await showRecordTour();
  mock.highlight.mockClear();
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
    x: 20,
    y: 50,
    width: 200,
    height: 50,
  } as DOMRect);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(mock.refresh).toHaveBeenCalledOnce();
  expect(mock.highlight).not.toHaveBeenCalled();
});

it('updates guidance when the same footer changes from waiting to retry', async () => {
  const {view,onError,onExit}=await showRecordTour();
  const target=anchor('transcript-wait');
  view.rerender(<AnchoredTour step="transcript" onContinue={vi.fn()} onExit={onExit} onError={onError}/>);
  await act(async()=>{await vi.dynamicImportSettled()});
  target.dataset.onboarding='record-retry';
  await act(async()=>{await vi.advanceTimersByTimeAsync(200)});
  expect(mock.highlight).toHaveBeenLastCalledWith(expect.objectContaining({element:target,popover:expect.objectContaining({title:'onboarding.tour.retry.title',showButtons:['close']})}));
});
