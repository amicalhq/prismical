import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchPrismical, closePrismical, type PrismicalLaunch } from './helpers/launch';

/**
 * Visible-render coverage for the two native-only panel renderers.
 *
 * Policy/domain projection and invoke routing are exhaustive at the unit layer
 * (widget-window-handlers.test.ts / notify-window-handlers.test.ts). This spec
 * closes the layer those tests cannot: a real Electron main process delivers a
 * valid push through the production preload buffer and the bundled React
 * renderer paints the controls a user sees.
 */
test.describe('native panel renderers', () => {
  let launched: PrismicalLaunch;

  test.beforeEach(async () => {
    launched = await launchPrismical();
    await launched.app.firstWindow({ timeout: 60_000 });
    await expect.poll(() => launched.app.windows().length, { timeout: 30_000 }).toBe(3);
  });

  test.afterEach(async () => {
    await closePrismical(launched);
  });

  const pageByUrl = (suffix: string): Page => {
    const page = launched.app
      .windows()
      .find(candidate => candidate.url().split('?')[0]?.split('#')[0]?.endsWith(suffix));
    expect(page, `window for ${suffix}`).toBeDefined();
    return page!;
  };

  const sendPanelState = async (
    app: ElectronApplication,
    suffix: string,
    channel: string,
    payload: unknown
  ): Promise<void> => {
    const windowId = await app.evaluate(
      ({ BrowserWindow }, message) => {
        const target = BrowserWindow.getAllWindows().find(window =>
          window.webContents.getURL().split('?')[0]?.split('#')[0]?.endsWith(message.suffix)
        );
        target?.webContents.send(message.channel, message.payload);
        return target?.id ?? null;
      },
      { suffix, channel, payload }
    );
    expect(windowId, `delivery target for ${channel}`).not.toBeNull();
  };

  test('widget paints recording, mic-only, pause, and elapsed-state controls', async () => {
    const widget = pageByUrl('widget.html');
    await widget.waitForLoadState('domcontentloaded');

    const elapsedAt = Date.now();
    await sendPanelState(launched.app, 'widget.html', 'widget:state', {
      locale: 'en',
      visible: true,
      mode: 'recording',
      recording: {
        status: 'recording',
        micOnly: true,
        canPause: true,
        startedAt: elapsedAt - 65_000,
        pausedAccumMs: 0,
        elapsedMs: 65_000,
        elapsedAt,
      },
    });

    const openApp = widget.getByRole('button', { name: 'Open the app' });
    await expect(openApp).toBeVisible();
    await expect(widget.getByLabel('Mic only')).toBeVisible();
    await openApp.hover();
    await expect(widget.getByRole('button', { name: 'Pause recording' })).toBeVisible();
    await expect(widget.getByRole('button', { name: 'Stop recording' })).toBeVisible();
    await expect(widget.getByRole('button', { name: 'Note' })).toBeVisible();

    await sendPanelState(launched.app, 'widget.html', 'widget:state', {
      locale: 'en',
      visible: true,
      mode: 'recording',
      recording: {
        status: 'paused',
        micOnly: false,
        canPause: true,
        startedAt: elapsedAt - 65_000,
        pausedAccumMs: 0,
        elapsedMs: 65_000,
        elapsedAt: null,
      },
    });

    await expect(widget.getByRole('button', { name: 'Resume recording' })).toBeVisible();
    await expect(widget.getByText('1:05', { exact: true })).toBeVisible();
    await expect(widget.getByLabel('Mic only')).toHaveCount(0);
  });

  test('notify paints stacked call and auto-pause cards, then clears them', async () => {
    const notify = pageByUrl('notify.html');
    await notify.waitForLoadState('domcontentloaded');

    const now = Date.now();
    await sendPanelState(launched.app, 'notify.html', 'notify:state', {
      locale: 'en',
      cards: [
        {
          id: 'auto-pause:e2e',
          kind: 'auto-pause',
          title: 'Still there?',
          subtitle: 'No sound for a while - pausing to save your minutes.',
          appName: null,
          calendarColor: null,
          joinUrl: null,
          expiresAtMs: now + 30_000,
          durationMs: 30_000,
          accent: 'amber',
          actions: [
            { id: 'keep-recording', label: 'Keep recording', primary: true },
            { id: 'pause', label: 'Pause', primary: false },
          ],
        },
        {
          id: 'call:e2e',
          kind: 'call-detected',
          title: 'Meeting detected',
          subtitle: 'Zoom is using your microphone',
          appName: 'Zoom',
          calendarColor: null,
          joinUrl: null,
          expiresAtMs: now + 12_000,
          durationMs: 12_000,
          accent: 'default',
          actions: [{ id: 'take-notes', label: 'Take Notes', primary: true }],
        },
      ],
    });

    await expect(notify.getByRole('button', { name: 'Still there? — dismiss' })).toBeVisible();
    await expect(notify.getByRole('button', { name: 'Meeting detected — dismiss' })).toBeVisible();
    await expect(notify.getByRole('button', { name: 'Keep recording' })).toBeVisible();
    await expect(notify.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect(notify.getByRole('button', { name: 'Take Notes' })).toBeVisible();

    await sendPanelState(launched.app, 'notify.html', 'notify:state', {
      locale: 'en',
      cards: [],
    });
    await expect(notify.getByRole('button', { name: 'Still there? — dismiss' })).toHaveCount(0);
    await expect(notify.getByRole('button', { name: 'Meeting detected — dismiss' })).toHaveCount(0);
  });
});
