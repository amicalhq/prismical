// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } from '../ui/sidebar';
import { SidebarNavigation } from './sidebar-navigation';
import { AppLink } from './app-link';

const route = vi.hoisted(() => ({ pathname: '/notes/example', search: '', mobile: true }));
vi.mock('../hooks/use-mobile', () => ({ useIsMobile: () => route.mobile }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@prismical/app-client', () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
  usePorts: () => ({ navigation: { Link: 'a' } }),
}));
afterEach(() => {
  cleanup();
  route.pathname = '/notes/example';
  route.search = '';
  route.mobile = true;
});

function State() {
  const { open, openMobile } = useSidebar();
  return <output data-testid="sidebar-state">{JSON.stringify({ open, openMobile })}</output>;
}
function Fixture({ linkProps = {} }: { linkProps?: Partial<React.ComponentProps<typeof AppLink>> }) {
  return (
    <SidebarProvider enableKeyboardShortcut={false}>
      <SidebarTrigger aria-label="Open navigation" />
      <SidebarNavigation>
        <Sidebar>
          <AppLink href="/notes" {...linkProps}>Notes</AppLink>
          <button>Expand folders</button>
        </Sidebar>
      </SidebarNavigation>
      <main><h1>Note title</h1></main>
      <State />
    </SidebarProvider>
  );
}
async function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
  await screen.findByRole('dialog');
}
async function expectClosed() {
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('heading', { name: 'Note title' })).toBeTruthy();
  expect(screen.getByTestId('sidebar-state').textContent).toBe('{"open":true,"openMobile":false}');
}

describe('sidebar navigation dismissal', () => {
  it.each(['/notes', '/notes/example'])('closes on a normal link selection, including current route %s', async href => {
    render(<React.StrictMode><Fixture linkProps={{ href }} /></React.StrictMode>);
    await openDrawer();
    fireEvent.click(screen.getByRole('link', { name: 'Notes' }));
    await expectClosed();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open navigation' })));
  });

  it.each([
    { pathname: '/notes', search: '' },
    { pathname: '/notes/example', search: 'folder=work' },
    { pathname: '/notes/example', search: 'tags=one&tags=two' },
  ])('closes on reactive route changes %j', async next => {
    const view = render(<Fixture />);
    await openDrawer();
    Object.assign(route, next);
    view.rerender(<Fixture />);
    await expectClosed();
  });

  it('stays open on unrelated rerenders and folder expansion', async () => {
    const view = render(<Fixture />);
    await openDrawer();
    view.rerender(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand folders' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])('keeps the drawer for alternate clicks %j', async modifiers => {
    render(<Fixture />);
    await openDrawer();
    fireEvent.click(screen.getByRole('link', { name: 'Notes' }), modifiers);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it.each([
    { target: '_blank' },
    { download: 'notes.txt' },
    { href: 'https://external.example/notes' },
    { onClick: (event: React.MouseEvent) => event.preventDefault() },
  ])('preserves non-navigation or cancelled link behavior %j', async linkProps => {
    render(<Fixture linkProps={linkProps} />);
    await openDrawer();
    fireEvent.click(screen.getByRole('link', { name: 'Notes' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('preserves the caller callback and forwarded anchor ref outside a sidebar', () => {
    const onClick = vi.fn((event: React.MouseEvent) => event.preventDefault());
    const ref = React.createRef<HTMLAnchorElement>();
    render(<AppLink href="/notes" onClick={onClick} ref={ref}>Notes</AppLink>);
    fireEvent.click(screen.getByRole('link'));
    expect(onClick).toHaveBeenCalledOnce();
    expect(ref.current).toBe(screen.getByRole('link'));
  });

  it('does not change a collapsed desktop sidebar on navigation', async () => {
    route.mobile = false;
    const view = render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(screen.getByRole('link', { name: 'Notes' }));
    route.pathname = '/notes';
    await act(async () => view.rerender(<Fixture />));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('sidebar-state').textContent).toBe('{"open":false,"openMobile":false}');
  });
});
