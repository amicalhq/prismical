// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  // Both flags are read off the STRICTLY resolved active org, never through the loose
  // `useFeatureFlag` fallback, so they live together here.
  activeOrg: { orgId: 'org_1', features: { welcomeVideo: true, userTour: false } } as {
    orgId: string;
    features: Record<string, boolean>;
  } | null,
  pathname: '/home',
  seen: false,
  update: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@prismical/app-client', () => ({
  EVENTS: { ONBOARDING_PROMPT_VIEWED: 'viewed', ONBOARDING_PROMPT_ACTIONED: 'actioned' },
  usePorts: () => ({ analytics: { capture: mocks.capture } }),
  useAccountExperience: () => ({
    data: { welcome: { seen: mocks.seen } },
    update: mocks.update,
  }),
  useActiveOrg: () => mocks.activeOrg,
  usePathname: () => mocks.pathname,
  useDesktopCapabilities: () => ({ has: () => false }),
}));

const { WelcomeVideoDialog } = await import('./welcome-video-dialog');

beforeEach(() => {
  mocks.activeOrg = { orgId: 'org_1', features: { welcomeVideo: true, userTour: false } };
  mocks.pathname = '/home';
  mocks.seen = false;
  mocks.update.mockReset();
  mocks.capture.mockReset();
});
afterEach(cleanup);

const dialog = () => screen.queryByRole('dialog');

it('opens once on home and records the acknowledgment', () => {
  render(<WelcomeVideoDialog />);
  expect(dialog()).not.toBeNull();
  expect(mocks.update).toHaveBeenCalledWith({ welcome: { seen: true } });
  expect(mocks.capture).toHaveBeenCalledWith('viewed', { prompt: 'welcome_video' });
});

it('embeds the player directly rather than through a redirecting link', () => {
  render(<WelcomeVideoDialog />);
  const frame = document.querySelector('iframe');
  expect(frame?.getAttribute('src')).toBe('https://livid.com/embed/gzamRht7O9Gd');
  // A nested frame would strip these; they are delegated explicitly to the cross-origin player.
  expect(frame?.getAttribute('allow')).toContain('fullscreen');
  expect(frame?.hasAttribute('allowfullscreen')).toBe(true);
});

it('stays closed while its flag is off, without spending the one-time prompt', () => {
  mocks.activeOrg = { orgId: 'org_1', features: { welcomeVideo: false, userTour: false } };
  render(<WelcomeVideoDialog />);
  expect(dialog()).toBeNull();
  // Burning the acknowledgment here would mean the account never sees the dialog once the kill
  // switch is released again.
  expect(mocks.update).not.toHaveBeenCalled();
});

it('stands down while the guided walkthrough is enabled', () => {
  mocks.activeOrg = { orgId: 'org_1', features: { welcomeVideo: true, userTour: true } };
  render(<WelcomeVideoDialog />);
  expect(dialog()).toBeNull();
  expect(mocks.update).not.toHaveBeenCalled();
});

it('waits for the active org rather than answering from a stale list', () => {
  mocks.activeOrg = null;
  const view = render(<WelcomeVideoDialog />);
  expect(dialog()).toBeNull();
  expect(mocks.update).not.toHaveBeenCalled();

  mocks.activeOrg = { orgId: 'org_1', features: { welcomeVideo: true, userTour: false } };
  view.rerender(<WelcomeVideoDialog />);
  expect(dialog()).not.toBeNull();
});

it.each(['/notes/note_1', '/settings/preferences'])('does not open over %s, only on home', path => {
  mocks.pathname = path;
  render(<WelcomeVideoDialog />);
  expect(dialog()).toBeNull();
  expect(mocks.update).not.toHaveBeenCalled();
});

it('never reopens for an account that has already seen it', () => {
  mocks.seen = true;
  render(<WelcomeVideoDialog />);
  expect(dialog()).toBeNull();
  expect(mocks.update).not.toHaveBeenCalled();
});

it('reports the dialog once even when the effect runs twice', () => {
  const view = render(<WelcomeVideoDialog />);
  view.rerender(<WelcomeVideoDialog />);
  expect(mocks.capture.mock.calls.filter(([event]) => event === 'viewed')).toHaveLength(1);
  expect(mocks.update).toHaveBeenCalledTimes(1);
});

/** A player.js message as the embedded player would post it: a JSON string from its own frame. */
const post = (event: string, value?: unknown) => {
  const frame = document.querySelector('iframe')!;
  window.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ context: 'player.js', version: '2.0', event, value }),
      origin: 'https://livid.com',
      source: frame.contentWindow,
    })
  );
};

const actions = () =>
  mocks.capture.mock.calls.filter(([event]) => event === 'actioned').map(([, props]) => props);

it('reports that the video was played, once, however many times the player says so', () => {
  render(<WelcomeVideoDialog />);
  post('ready');
  post('play');
  post('play');

  expect(actions().filter(p => p.action === 'video_play')).toHaveLength(1);
});

it('reports a completed view when the player reaches the end', () => {
  render(<WelcomeVideoDialog />);
  post('ready');
  post('play');
  post('ended');

  expect(actions().filter(p => p.action === 'video_completed')).toHaveLength(1);
});

it('ignores player messages from any other origin', () => {
  render(<WelcomeVideoDialog />);
  const frame = document.querySelector('iframe')!;
  window.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ context: 'player.js', event: 'play' }),
      origin: 'https://not-the-player.example',
      source: frame.contentWindow,
    })
  );

  expect(actions().filter(p => p.action === 'video_play')).toHaveLength(0);
});

it('carries how much was watched on the closing event, keeping the furthest position', () => {
  render(<WelcomeVideoDialog />);
  post('ready');
  post('play');
  post('timeupdate', { seconds: 50, duration: 100 });
  // Scrubbing backwards must not shrink what was watched.
  post('timeupdate', { seconds: 10, duration: 100 });
  fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));

  const close = actions().find(p => p.action === 'dismissed')!;
  expect(close.video_played).toBe(true);
  expect(close.video_seconds_watched).toBe(50);
  expect(close.video_percent_watched).toBe(50);
});

it('omits the watched fields entirely when the player never reported a position', () => {
  render(<WelcomeVideoDialog />);
  fireEvent.click(screen.getByRole('button', { name: 'common.actions.close' }));

  const close = actions().find(p => p.action === 'dismissed')!;
  expect(close.video_played).toBe(false);
  expect('video_percent_watched' in close).toBe(false);
});

it('offers exactly one way out, and it is never scrolled out of reach', () => {
  render(<WelcomeVideoDialog />);
  const close = screen.getByRole('button', { name: 'common.actions.close' });

  // The close control is the only dismiss affordance now that the footer buttons are gone. Assert
  // reachability rather than the absence of a class: it must be a direct child of the capped,
  // fixed-position dialog box, so no amount of content can push it out of the viewport.
  expect(screen.queryByText('onboarding.later')).toBeNull();
  const content = close.closest('[data-slot="dialog-content"]');
  expect(close.parentElement).toBe(content);
  expect(content?.className).toContain('max-h-[calc(100dvh-2rem)]');

  fireEvent.click(close);
  expect(dialog()).toBeNull();
});

it('lays the download buttons out in fixed columns rather than letting one wrap alone', () => {
  render(<WelcomeVideoDialog />);
  // `Button asChild` renders the anchor itself, so the row is the anchor's direct parent.
  const row = screen.getByRole('link', { name: /platforms.ios/ }).parentElement!;

  // Columns, not a wrapping flex row: a fourth button that wrapped alone would stretch to the full
  // width on the viewports between a phone and a tablet.
  expect(row.className).toContain('sm:grid-cols-4');
  expect(row.className).toContain('grid-cols-2');
  expect(row.className).not.toContain('flex-wrap');
});

it('gives the close control a real touch target, not a bare icon', () => {
  render(<WelcomeVideoDialog />);
  const close = screen.getByRole('button', { name: 'common.actions.close' });

  // The shared dialog close is an unpadded 16px icon. As the ONLY labelled exit that is below the
  // minimum touch target, so this dialog opts out of it and pads its own.
  expect(close.className).toContain('p-2');
});

it('keeps the accent visible in dark mode, where the outline variant would otherwise win', () => {
  render(<WelcomeVideoDialog />);
  const ios = screen.getByRole('link', { name: /platforms.ios/ });

  // `dark:bg-input/30` on the outline button outranks an un-prefixed tint, so the dark variants
  // are what make the row read as accented rather than grey.
  expect(ios.className).toContain('dark:bg-indigo-500/10');
  expect(ios.className).toContain('bg-indigo-500/5');
});
