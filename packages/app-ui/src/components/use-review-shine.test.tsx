// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReviewShine } from './use-review-shine';

function Dock({ id, ready = true }: { id: string; ready?: boolean }) {
  const ref = useReviewShine(id, ready);
  return <div ref={ref} data-testid="dock"><input /><button>Keep</button></div>;
}
let motion: MediaQueryList;
let serial = 0;
const identity = () => `result-${++serial}`;
beforeEach(() => {
  const target = new EventTarget();
  motion = Object.assign(target, { matches: false, media: '', onchange: null }) as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', () => motion);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const shining = (dock: HTMLElement) => dock.hasAttribute('data-review-shine');
describe('review attention', () => {
  it('enables only when ready and cleans up on state change', () => {
    const id = identity();
    const view = render(<Dock id={id} ready={false} />);
    expect(shining(view.getByTestId('dock'))).toBe(false);
    view.rerender(<Dock id={id} />);
    expect(shining(view.getByTestId('dock'))).toBe(true);
    view.rerender(<Dock id={id} ready={false} />);
    expect(shining(view.getByTestId('dock'))).toBe(false);
  });
  it.each(['pointerenter', 'pointerdown', 'touchstart', 'focusin', 'input', 'keydown', 'click'])('stops on %s across leave, blur and remount', event => {
    const id = identity();
    const view = render(<Dock id={id} />);
    const dock = view.getByTestId('dock');
    fireEvent(dock.querySelector('input')!, new Event(event, { bubbles: true }));
    expect(shining(dock)).toBe(false);
    fireEvent.pointerLeave(dock);
    fireEvent.blur(dock);
    view.unmount();
    const reopened = render(<Dock id={id} />);
    expect(shining(reopened.getByTestId('dock'))).toBe(false);
    reopened.rerender(<Dock id={identity()} />);
    expect(shining(reopened.getByTestId('dock'))).toBe(true);
  });
  it('honors stored recovery identity', () => {
    const id = identity();
    sessionStorage.setItem(`review-attended:v1:${id}`, '1');
    const view = render(<Dock id={id} />);
    expect(shining(view.getByTestId('dock'))).toBe(false);
  });
  it('suppresses a new proposal when focus is already inside', () => {
    const view = render(<Dock id={identity()} />);
    act(() => view.getByTestId('dock').querySelector('input')!.focus());
    view.rerender(<Dock id={identity()} />);
    expect(shining(view.getByTestId('dock'))).toBe(false);
  });
  it('suppresses a new proposal when the pointer is already inside', () => {
    const matches = vi.spyOn(Element.prototype, 'matches');
    matches.mockImplementation(selector => selector === ':hover');
    const view = render(<Dock id={identity()} />);
    expect(shining(view.getByTestId('dock'))).toBe(false);
  });
  it('removes the animation when hidden or reduced motion changes, then starts a fresh cycle', () => {
    const view = render(<Dock id={identity()} />);
    const dock = view.getByTestId('dock');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    fireEvent(document, new Event('visibilitychange'));
    expect(shining(dock)).toBe(false);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fireEvent(document, new Event('visibilitychange'));
    expect(shining(dock)).toBe(true);
    Object.assign(motion, { matches: true });
    act(() => motion.dispatchEvent(new Event('change')));
    expect(shining(dock)).toBe(false);
    Object.assign(motion, { matches: false });
    act(() => motion.dispatchEvent(new Event('change')));
    expect(shining(dock)).toBe(true);
  });
  it('starts quiet with reduced motion and does not intercept actions', () => {
    Object.assign(motion, { matches: true });
    const view = render(<Dock id={identity()} />);
    const dock = view.getByTestId('dock');
    expect(shining(dock)).toBe(false);
    const action = vi.fn();
    dock.querySelector('button')!.addEventListener('click', action);
    fireEvent.click(dock.querySelector('button')!);
    expect(action).toHaveBeenCalledOnce();
    Object.assign(motion, { matches: false });
    act(() => motion.dispatchEvent(new Event('change')));
    expect(shining(dock)).toBe(false);
  });
});
