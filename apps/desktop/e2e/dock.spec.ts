import { test, expect } from '@playwright/test';
import { launchPrismical, closePrismical, type PrismicalLaunch } from './helpers/launch';

/**
 * The dock window family — real-Electron posture checks:
 *  - boot opens exactly main + widget + notify; NO float window pre-auth
 *    (the float is auth-gated and on-demand);
 *  - every E2E window stays natively hidden/unfocused and unthrottled;
 *  - the widget/notify panels retain their production always-on-top posture;
 *  - the sanitized preload membrane: the panel pages expose ONLY their
 *    tiny verb surface (`window.widget` / `window.notify`, exact keys pinned)
 *    and never the main-grade `window.desktop`; the main page gets none of
 *    the panel surfaces.
 */
test.describe('dock windows', () => {
  let launched: PrismicalLaunch;

  test.beforeEach(async () => {
    launched = await launchPrismical();
  });

  test.afterEach(async () => {
    await closePrismical(launched);
  });

  const pageByUrl = (suffix: string) => {
    const page = launched.app
      .windows()
      .find(candidate => candidate.url().split('?')[0]?.split('#')[0]?.endsWith(suffix));
    expect(page, `window for ${suffix}`).toBeDefined();
    return page!;
  };

  test('boot keeps main + widget + notify hidden, unfocused, and unthrottled', async () => {
    await launched.app.firstWindow({ timeout: 60_000 });
    await expect.poll(() => launched.app.windows().length, { timeout: 30_000 }).toBe(3);

    const posture = await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(window => ({
        url: window.webContents.getURL().split('?')[0],
        alwaysOnTop: window.isAlwaysOnTop(),
        visible: window.isVisible(),
        focused: window.isFocused(),
        backgroundThrottling: window.webContents.getBackgroundThrottling(),
      }))
    );
    const byPage = (suffix: string) =>
      posture.find(entry => (entry.url ?? '').split('#')[0]?.endsWith(suffix));

    expect(byPage('index.html'), 'main window').toBeDefined();
    expect(byPage('widget.html'), 'widget window').toBeDefined();
    expect(byPage('notify.html'), 'notify window').toBeDefined();
    expect(byPage('index.html')?.alwaysOnTop).toBe(false);
    expect(byPage('widget.html')?.alwaysOnTop).toBe(true);
    expect(byPage('notify.html')?.alwaysOnTop).toBe(true);
    expect(byPage('index.html')).toMatchObject({
      visible: false,
      focused: false,
      backgroundThrottling: false,
    });
    expect(byPage('widget.html')).toMatchObject({
      visible: false,
      focused: false,
      backgroundThrottling: false,
    });
    expect(byPage('notify.html')).toMatchObject({
      visible: false,
      focused: false,
      backgroundThrottling: false,
    });
    // The float is auth-gated + on-demand: never open at a signed-out boot.
    expect(posture).toHaveLength(3);
  });

  test('panel preloads expose ONLY their sanitized surfaces', async () => {
    await launched.app.firstWindow({ timeout: 60_000 });
    await expect.poll(() => launched.app.windows().length, { timeout: 30_000 }).toBe(3);

    const widgetPage = pageByUrl('widget.html');
    const notifyPage = pageByUrl('notify.html');
    const mainPage = pageByUrl('index.html');

    const widgetShape = await widgetPage.evaluate(() => {
      const globals = window as unknown as Record<string, unknown>;
      return {
        widgetKeys: Object.keys((globals.widget as object) ?? {}).sort(),
        hasDesktop: 'desktop' in globals,
        hasNotify: 'notify' in globals,
      };
    });
    expect(widgetShape.widgetKeys).toEqual([
      'dragEnd',
      'dragMove',
      'expandNote',
      'getState',
      'logging',
      'onLevel',
      'onState',
      'openMain',
      'pauseRecording',
      'resumeRecording',
      'setInteractive',
      'startRecording',
      'stopRecording',
      'telemetry',
    ]);
    expect(widgetShape.hasDesktop).toBe(false);
    expect(widgetShape.hasNotify).toBe(false);

    const notifyShape = await notifyPage.evaluate(() => {
      const globals = window as unknown as Record<string, unknown>;
      return {
        notifyKeys: Object.keys((globals.notify as object) ?? {}).sort(),
        hasDesktop: 'desktop' in globals,
        hasWidget: 'widget' in globals,
      };
    });
    expect(notifyShape.notifyKeys).toEqual(['action', 'getState', 'logging', 'onState', 'setInteractive', 'telemetry']);
    expect(notifyShape.hasDesktop).toBe(false);
    expect(notifyShape.hasWidget).toBe(false);

    const mainShape = await mainPage.evaluate(() => {
      const globals = window as unknown as Record<string, unknown>;
      return {
        hasDesktop: 'desktop' in globals,
        hasWidget: 'widget' in globals,
        hasNotify: 'notify' in globals,
      };
    });
    expect(mainShape.hasDesktop).toBe(true);
    expect(mainShape.hasWidget).toBe(false);
    expect(mainShape.hasNotify).toBe(false);
  });
});
