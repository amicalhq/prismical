// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopChromeStrip } from './desktop-chrome-strip';

const harness = vi.hoisted(() => ({
  platform: 'mac',
  target: null as HTMLDivElement | null,
  resize: () => {},
  disconnect: vi.fn(),
}));
vi.mock('@prismical/app-client', () => ({
  useDesktopCapabilities: () => ({
    has: (cap: string) => cap === `window-chrome-${harness.platform}`,
  }),
}));
vi.mock('./current-note-context', () => ({
  useCurrentNote: () => ({ headerActionsTarget: harness.target }),
}));
vi.mock('../ui/sidebar', () => ({ SidebarTrigger: () => <button>Toggle sidebar</button> }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(['mac', 'windows'])(
  'excludes header actions from the later %s drag rectangle and restores it when actions leave',
  platform => {
    harness.platform = platform;
    harness.target = document.createElement('div');
    const bounds = vi.spyOn(harness.target, 'getBoundingClientRect');
    bounds.mockReturnValue({ left: 824, width: 176 } as DOMRect);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          harness.resize = callback;
        }
        observe() {}
        disconnect = harness.disconnect;
      }
    );
    const { container, unmount } = render(<DesktopChromeStrip />);
    expect((container.firstChild as HTMLElement).style.right).toBe(`${window.innerWidth - 824}px`);
    bounds.mockReturnValue({ left: 700, width: 300 } as DOMRect);
    act(() => harness.resize());
    expect((container.firstChild as HTMLElement).style.right).toBe(`${window.innerWidth - 700}px`);
    bounds.mockReturnValue({ left: 1000, width: 0 } as DOMRect);
    act(() => harness.resize());
    expect((container.firstChild as HTMLElement).style.right).toBe('0px');
    unmount();
    expect(harness.disconnect).toHaveBeenCalled();
  }
);

it('renders no drag strip on web', () => {
  harness.platform = 'web';
  const { container } = render(<DesktopChromeStrip />);
  expect(container.childElementCount).toBe(0);
});
