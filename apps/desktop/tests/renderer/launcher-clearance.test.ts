// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launcherOverlapsDock, useLauncherClearance } from '../../src/renderer/main/app/support/launcher-clearance';

const launcherBounds = { left: 932, right: 980, top: 832, bottom: 880 };

describe('support launcher clearance', () => {
  it('allows a compact dock but hides for an expanded dock', () => {
    expect(launcherOverlapsDock(launcherBounds, [{ left: 400, right: 850, top: 838, bottom: 880 }])).toBe(false);
    expect(launcherOverlapsDock(launcherBounds, [{ left: 280, right: 956, top: 200, bottom: 880 }])).toBe(true);
  });

  it('requires a 12px gap and ignores empty or vertically separate obstacles', () => {
    expect(launcherOverlapsDock(launcherBounds, [{ left: 400, right: 920, top: 838, bottom: 880 }])).toBe(false);
    expect(launcherOverlapsDock(launcherBounds, [{ left: 400, right: 921, top: 838, bottom: 880 }])).toBe(true);
    expect(launcherOverlapsDock(launcherBounds, [{ left: 932, right: 980, top: 200, bottom: 800 }])).toBe(false);
    expect(launcherOverlapsDock(launcherBounds, [{ left: 950, right: 950, top: 838, bottom: 880 }])).toBe(false);
    expect(launcherOverlapsDock(launcherBounds, [])).toBe(false);
  });
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let resize: () => void;
const observe = vi.fn();
const disconnect = vi.fn();
function Clearance({ enabled }: { enabled: boolean }) {
  useLauncherClearance(enabled);
  return null;
}
const render = (enabled: boolean) => act(async () => root.render(createElement(Clearance, { enabled })));
const flush = () => act(async () => vi.advanceTimersByTimeAsync(20));
const obstructed = () => document.documentElement.hasAttribute('data-support-launcher-obstructed');

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('tracks SDK insertion, dock expansion, removal, and cloud support teardown', async () => {
  await render(false);
  expect(observe).not.toHaveBeenCalled();
  await render(true);
  expect(obstructed()).toBe(false);

  const launcher = document.createElement('button');
  launcher.className = 'bb-feedback-button';
  launcher.getBoundingClientRect = () => new DOMRect(932, 832, 48, 48);
  const dock = document.createElement('div');
  dock.setAttribute('data-toast-obstacle', '');
  dock.getBoundingClientRect = () => new DOMRect(400, 838, 450, 42);
  document.body.append(launcher, dock);
  await flush();
  expect(obstructed()).toBe(false);
  expect(observe).toHaveBeenCalledWith(launcher);
  expect(observe).toHaveBeenCalledWith(dock);

  dock.getBoundingClientRect = () => new DOMRect(280, 200, 676, 680);
  resize();
  await flush();
  expect(obstructed()).toBe(true);

  dock.removeAttribute('data-toast-obstacle');
  await flush();
  expect(obstructed()).toBe(false);
  dock.setAttribute('data-toast-obstacle', '');
  await flush();
  expect(obstructed()).toBe(true);

  await render(false);
  expect(obstructed()).toBe(false);
  expect(disconnect).toHaveBeenCalled();
  window.dispatchEvent(new Event('resize'));
  await flush();
  expect(obstructed()).toBe(false);
});
