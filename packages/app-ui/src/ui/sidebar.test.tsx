// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } from './sidebar';

const device = vi.hoisted(() => ({ mobile: true }));
vi.mock('../hooks/use-mobile', () => ({ useIsMobile: () => device.mobile }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  device.mobile = true;
});

function CloseNavigation() {
  const { setOpenMobile } = useSidebar();
  return <button onClick={() => setOpenMobile(false)}>Navigate</button>;
}
function Fixture({ cancel = false }: { cancel?: boolean }) {
  return (
    <SidebarProvider enableKeyboardShortcut={false}>
      <SidebarTrigger
        aria-label="First opener"
        onClick={e => {
          if (cancel) e.preventDefault();
        }}
      />
      <SidebarTrigger aria-label="Second opener" />
      <Sidebar>
        <button>Inside navigation</button>
        <CloseNavigation />
      </Sidebar>
    </SidebarProvider>
  );
}
async function closeWithEscape() {
  const dialog = await screen.findByRole('dialog');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

describe('navigation focus restoration', () => {
  it('returns focus to the opener after Escape in strict mode', async () => {
    render(
      <React.StrictMode>
        <Fixture />
      </React.StrictMode>
    );
    const opener = screen.getByRole('button', { name: 'First opener' });
    opener.focus();
    fireEvent.click(opener);
    await closeWithEscape();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
  it('tracks the actual opener across repeated opens', async () => {
    render(<Fixture />);
    for (const name of ['First opener', 'Second opener', 'First opener']) {
      const opener = screen.getByRole('button', { name });
      opener.focus();
      fireEvent.click(opener);
      await closeWithEscape();
      await waitFor(() => expect(document.activeElement).toBe(opener));
    }
  });
  it('restores a pointer opener even when clicking did not focus it', async () => {
    render(<Fixture />);
    const opener = screen.getByRole('button', { name: 'Second opener' });
    fireEvent.click(opener);
    await closeWithEscape();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
  it('restores focus after a controlled navigation close', async () => {
    render(<Fixture />);
    const opener = screen.getByRole('button', { name: 'First opener' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole('button', { name: 'Navigate' }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
  it('respects a cancelled opener click', () => {
    render(<Fixture cancel />);
    fireEvent.click(screen.getByRole('button', { name: 'First opener' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('keeps desktop toggling inline instead of opening a dialog', () => {
    device.mobile = false;
    const { container } = render(<Fixture />);
    const opener = screen.getByRole('button', { name: 'First opener' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('[data-state="collapsed"]')).not.toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
