/**
 * Fake `electron` module for Effect-service tests (vi.mock target).
 *
 * Faithful where the services depend on behavior: EventEmitter app,
 * BrowserWindow/webContents recording listeners + destroy, session with
 * permission/webRequest/protocol capture, safeStorage fake, linked
 * MessageChannelMain pair, ipcMain handle/removeHandler bookkeeping.
 * NO catch-and-continue anywhere — misuse should throw in tests.
 */
import { EventEmitter } from 'node:events';

export class FakeEvent {
  defaultPrevented = false;
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeApp extends EventEmitter {
  isPackaged = false;
  quitCount = 0;
  exitCalls: number[] = [];
  activationPolicyCalls: string[] = [];
  protocolRegistrations: Array<{ scheme: string }> = [];
  locale = 'en-US';
  preferredSystemLanguages = ['en-US'];
  private paths = new Map<string, string>([['userData', '/fake/user-data']]);

  focusCalls: Array<{ steal?: boolean } | undefined> = [];
  focus(options?: { steal?: boolean }): void {
    this.focusCalls.push(options);
  }

  whenReady(): Promise<void> {
    return Promise.resolve();
  }
  getPath(name: string): string {
    return this.paths.get(name) ?? `/fake/${name}`;
  }
  setPath(name: string, value: string): void {
    this.paths.set(name, value);
  }
  getAppPath(): string {
    return '/fake/app-path';
  }
  getVersion(): string {
    return '0.0.0-test';
  }
  getLocale(): string {
    return this.locale;
  }
  getPreferredSystemLanguages(): string[] {
    return [...this.preferredSystemLanguages];
  }
  quit(): void {
    this.quitCount += 1;
    // Mirrors real Electron: quit drives before-quit (cancellable).
    this.emit('before-quit', new FakeEvent());
  }
  exit(code: number): void {
    this.exitCalls.push(code);
  }
  requestSingleInstanceLock(): boolean {
    return true;
  }
  setAsDefaultProtocolClient(scheme: string): boolean {
    this.protocolRegistrations.push({ scheme });
    return true;
  }
  setActivationPolicy(policy: string): void {
    this.activationPolicyCalls.push(policy);
  }
}

let nextWebContentsId = 1;
let nextWindowId = 1;

type WindowOpenHandler = (details: { url: string }) => { action: 'allow' | 'deny' };

export class FakeWebContents extends EventEmitter {
  getOSProcessId(): number { return this.id + 1000; }
  readonly id = nextWebContentsId++;
  windowOpenHandler: WindowOpenHandler | null = null;
  sent: Array<{ channel: string; payload: unknown }> = [];
  posted: Array<{ channel: string; message: unknown; transfer: FakeMessagePortMain[] }> = [];

  setWindowOpenHandler(handler: WindowOpenHandler | null): void {
    this.windowOpenHandler = handler;
  }
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
  postMessage(channel: string, message: unknown, transfer: FakeMessagePortMain[] = []): void {
    this.posted.push({ channel, message, transfer });
  }
}

export class FakeBrowserWindow extends EventEmitter {
  static instances: FakeBrowserWindow[] = [];
  readonly id = nextWindowId++;
  readonly webContents = new FakeWebContents();
  readonly options: unknown;
  loadedUrls: string[] = [];
  private destroyed = false;
  private minimized = false;
  private visible = true;
  // Window bounds, seeded from the constructor options (widget drag reads
  // getBounds / repositions with setBounds).
  private bounds: { x: number; y: number; width: number; height: number };
  setBoundsCalls: Array<{ x: number; y: number; width: number; height: number }> = [];
  focusCount = 0;
  showCount = 0;
  // Widget-window controls — recorded, never silently no-op'd.
  showInactiveCount = 0;
  ignoreMouseCalls: Array<{ ignore: boolean; options?: { forward?: boolean } }> = [];
  contentProtectionCalls: boolean[] = [];
  alwaysOnTopCalls: Array<{ flag: boolean; level?: string; relativeLevel?: number }> = [];
  visibleOnAllWorkspacesCalls: Array<{
    visible: boolean;
    options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean };
  }> = [];
  hiddenInMissionControl: boolean | null = null;

  constructor(options?: unknown) {
    super();
    this.options = options;
    const o = (options ?? {}) as { x?: number; y?: number; width?: number; height?: number };
    this.bounds = { x: o.x ?? 0, y: o.y ?? 0, width: o.width ?? 800, height: o.height ?? 600 };
    FakeBrowserWindow.instances.push(this);
  }
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.bounds };
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = { ...bounds };
    this.setBoundsCalls.push({ ...bounds });
  }
  loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    return Promise.resolve();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
  /** Simulates the user closing the window (destroy + closed event). */
  simulateUserClose(): void {
    this.destroy();
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  restore(): void {
    this.minimized = false;
  }
  show(): void {
    this.visible = true;
    this.showCount += 1;
  }
  /** Widget: show WITHOUT stealing focus. */
  showInactive(): void {
    this.visible = true;
    this.showInactiveCount += 1;
  }
  isVisible(): boolean {
    return this.visible;
  }
  focus(): void {
    this.focusCount += 1;
  }
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void {
    this.ignoreMouseCalls.push({ ignore, options });
  }
  setContentProtection(enabled: boolean): void {
    this.contentProtectionCalls.push(enabled);
  }
  setAlwaysOnTop(flag: boolean, level?: string, relativeLevel?: number): void {
    this.alwaysOnTopCalls.push({ flag, level, relativeLevel });
  }
  setVisibleOnAllWorkspaces(
    visible: boolean,
    options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }
  ): void {
    this.visibleOnAllWorkspacesCalls.push({ visible, options });
  }
  setHiddenInMissionControl(hidden: boolean): void {
    this.hiddenInMissionControl = hidden;
  }
}

export type PermissionRequestHandler =
  | ((
      webContents: FakeWebContents | null,
      permission: string,
      callback: (granted: boolean) => void
    ) => void)
  | null;

export type BeforeSendHeadersHandler =
  | ((
      details: { requestHeaders: Record<string, string>; url: string },
      callback: (response: { requestHeaders: Record<string, string> }) => void
    ) => void)
  | null;

export type HeadersReceivedHandler =
  | ((
      details: { responseHeaders?: Record<string, string[]>; url: string },
      callback: (response: { responseHeaders?: Record<string, string[]> }) => void
    ) => void)
  | null;

export type PermissionCheckHandler =
  | ((
      webContents: FakeWebContents | null,
      permission: string,
      requestingOrigin?: string,
      details?: unknown
    ) => boolean)
  | null;

class FakeSession {
  permissionRequestHandler: PermissionRequestHandler = null;
  permissionCheckHandler: PermissionCheckHandler = null;
  headersReceivedHandler: HeadersReceivedHandler = null;
  beforeSendHeadersHandler: BeforeSendHeadersHandler = null;
  beforeSendHeadersFilter: { urls: string[] } | null = null;
  /** capability:resetApp wipes renderer storage — record each call. */
  readonly clearStorageDataCalls: Array<{ storages?: readonly string[] }> = [];
  clearStorageData(options?: { storages?: readonly string[] }): Promise<void> {
    this.clearStorageDataCalls.push(options ?? {});
    return Promise.resolve();
  }
  readonly protocol = {
    handlers: new Map<string, (request: { url: string }) => unknown>(),
    handle(scheme: string, handler: (request: { url: string }) => unknown): void {
      if (this.handlers.has(scheme)) throw new Error(`scheme already handled: ${scheme}`);
      this.handlers.set(scheme, handler);
    },
    unhandle(scheme: string): void {
      this.handlers.delete(scheme);
    },
    isProtocolHandled(scheme: string): boolean {
      return this.handlers.has(scheme);
    },
  };
  readonly webRequest = {
    onBeforeSendHeaders: (
      filter: { urls: string[] } | null,
      handler?: BeforeSendHeadersHandler
    ): void => {
      this.beforeSendHeadersFilter = filter;
      this.beforeSendHeadersHandler = handler ?? null;
    },
    onHeadersReceived: (handler: HeadersReceivedHandler): void => {
      this.headersReceivedHandler = handler;
    },
  };
  setPermissionRequestHandler(handler: PermissionRequestHandler): void {
    this.permissionRequestHandler = handler;
  }
  setPermissionCheckHandler(handler: PermissionCheckHandler): void {
    this.permissionCheckHandler = handler;
  }
}

export class FakePowerMonitor extends EventEmitter {}

class FakeSafeStorage {
  available = true;
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  encryptString(plaintext: string): Buffer {
    if (!this.available) throw new Error('encryption unavailable');
    return Buffer.from(`enc:${plaintext}`, 'utf8');
  }
  decryptString(payload: Buffer): string {
    const decoded = payload.toString('utf8');
    if (!decoded.startsWith('enc:')) throw new Error('bad ciphertext');
    return decoded.slice(4);
  }
}

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpcMain {
  handlers = new Map<string, IpcHandler>();
  handle(channel: string, handler: IpcHandler): void {
    if (this.handlers.has(channel)) throw new Error(`ipcMain.handle duplicate: ${channel}`);
    this.handlers.set(channel, handler);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  /** Test driver: invoke a registered handler the way a renderer would. */
  async invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return await handler(event, ...args);
  }
}

export class FakeMessagePortMain extends EventEmitter {
  peer: FakeMessagePortMain | null = null;
  started = false;
  closed = false;
  delivered: unknown[] = []; // messages posted INTO this port (received by peer owner)

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('port closed');
    const peer = this.peer;
    if (peer === null) throw new Error('port not linked');
    // Deliver asynchronously like the real thing.
    queueMicrotask(() => {
      if (!peer.closed) {
        peer.delivered.push(message);
        peer.emit('message', { data: message });
      }
    });
  }
  start(): void {
    this.started = true;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    if (peer !== null && !peer.closed) {
      queueMicrotask(() => {
        peer.emit('close');
      });
    }
  }
}

export class FakeMessageChannelMain {
  readonly port1 = new FakeMessagePortMain();
  readonly port2 = new FakeMessagePortMain();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

class FakeTray extends EventEmitter {
  static instances: FakeTray[] = [];
  readonly image: unknown;
  contextMenu: unknown = undefined;
  tooltip = '';
  private destroyed = false;

  constructor(image: unknown) {
    super();
    this.image = image;
    FakeTray.instances.push(this);
  }
  setToolTip(tip: string): void {
    this.tooltip = tip;
  }
  setContextMenu(menu: unknown): void {
    this.contextMenu = menu;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

export interface FakeMenuItem {
  label?: string;
  type?: string;
  role?: string;
  accelerator?: string;
  submenu?: FakeMenuItem[];
  click?: () => void;
}

/**
 * Fake native autoUpdater. `checkForUpdates()` synchronously walks a
 * scripted cycle (default: checking → update-not-available) so clock-driven
 * cadence tests settle deterministically; tests reprogram `nextCycle` to stage
 * downloads or fail.
 */
export class FakeAutoUpdater extends EventEmitter {
  feedURLs: Array<{ url: string; headers?: Record<string, string> }> = [];
  checkCalls = 0;
  quitAndInstallCalls = 0;
  /** The events the next checkForUpdates() emits, in order. */
  nextCycle: Array<[string, ...unknown[]]> = [['checking-for-update'], ['update-not-available']];

  setFeedURL(options: { url: string; headers?: Record<string, string> }): void {
    this.feedURLs.push(options);
  }

  checkForUpdates(): void {
    this.checkCalls += 1;
    for (const [event, ...args] of this.nextCycle) {
      this.emit(event, ...args);
    }
  }

  quitAndInstall(): void {
    this.quitAndInstallCalls += 1;
  }
}

export interface FakeElectron {
  app: FakeApp;
  BrowserWindow: typeof FakeBrowserWindow;
  Tray: typeof FakeTray;
  Menu: {
    buildFromTemplate: (template: FakeMenuItem[]) => { items: FakeMenuItem[] };
    setApplicationMenu: (menu: { items: FakeMenuItem[] } | null) => void;
  };
  nativeImage: {
    createFromPath: (path: string) => { path: string; setTemplateImage: (flag: boolean) => void };
  };
  session: { defaultSession: FakeSession };
  safeStorage: FakeSafeStorage;
  powerMonitor: FakePowerMonitor;
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => boolean;
    unregister: (accelerator: string) => void;
    isRegistered: (accelerator: string) => boolean;
    __registered: () => Map<string, () => void>;
  };
  screen: {
    getPrimaryDisplay: () => {
      id: number;
      workArea: { x: number; y: number; width: number; height: number };
    };
    getAllDisplays: () => Array<{
      id: number;
      workArea: { x: number; y: number; width: number; height: number };
    }>;
    getDisplayNearestPoint: (point: { x: number; y: number }) => {
      id: number;
      workArea: { x: number; y: number; width: number; height: number };
    };
  };
  ipcMain: FakeIpcMain;
  shell: { openExternalCalls: string[]; openExternal: (url: string) => Promise<void> };
  MessageChannelMain: typeof FakeMessageChannelMain;
  net: { fetch: (url: string) => Promise<Response> };
  autoUpdater: FakeAutoUpdater;
  protocol: { registerSchemesAsPrivileged: (schemes: unknown[]) => void };
  dialog: { showErrorBox: (title: string, content: string) => void };
  /** Test helpers, not part of the electron surface. */
  __trayInstances: () => FakeTray[];
  __windowInstances: () => FakeBrowserWindow[];
  __applicationMenu: () => { items: FakeMenuItem[] } | null;
  __appListenerTotal: () => number;
}

export function createFakeElectron(): FakeElectron {
  const app = new FakeApp();
  const session = { defaultSession: new FakeSession() };
  const safeStorage = new FakeSafeStorage();
  const powerMonitor = new FakePowerMonitor();
  const ipcMain = new FakeIpcMain();
  const shell = {
    openExternalCalls: [] as string[],
    openExternal(url: string): Promise<void> {
      shell.openExternalCalls.push(url);
      return Promise.resolve();
    },
  };
  // Per-fake instance registries (module-level statics would leak across
  // createFakeElectron calls within one test file).
  FakeBrowserWindow.instances = [];
  FakeTray.instances = [];
  let applicationMenu: { items: FakeMenuItem[] } | null = null;

  return {
    app,
    BrowserWindow: FakeBrowserWindow,
    Tray: FakeTray,
    Menu: {
      buildFromTemplate: template => ({ items: template }),
      setApplicationMenu: menu => {
        applicationMenu = menu;
      },
    },
    nativeImage: {
      createFromPath: path => ({
        path,
        setTemplateImage: () => undefined,
      }),
    },
    session,
    safeStorage,
    powerMonitor,
    globalShortcut: (() => {
      const registeredShortcuts = new Map<string, () => void>();
      return {
        register: (accelerator: string, callback: () => void) => {
          if (accelerator.includes('!')) return false; // test hook: '!' = OS conflict
          // Test hook: '@' = syntactically invalid accelerator — real Electron
          // THROWS (conversion failure) rather than returning false.
          if (accelerator.includes('@')) throw new Error(`invalid accelerator: ${accelerator}`);
          registeredShortcuts.set(accelerator, callback);
          return true;
        },
        unregister: (accelerator: string) => {
          registeredShortcuts.delete(accelerator);
        },
        isRegistered: (accelerator: string) => registeredShortcuts.has(accelerator),
        __registered: () => registeredShortcuts,
      };
    })(),
    // A single fixed primary display (id 1, 1440x900 work area). The dock drag
    // path resolves the display nearest the POINTER and the open path resolves
    // the saved display id; with one display both always land
    // here — the multi-display resolution logic is covered by the pure
    // dock-geometry tests.
    screen: {
      getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
      getDisplayNearestPoint: () => ({
        id: 1,
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
      }),
    },
    ipcMain,
    shell,
    MessageChannelMain: FakeMessageChannelMain,
    net: {
      fetch: () => Promise.resolve(new Response('fake', { status: 200 })),
    },
    autoUpdater: new FakeAutoUpdater(),
    protocol: { registerSchemesAsPrivileged: () => undefined },
    dialog: { showErrorBox: () => undefined },
    __trayInstances: () => FakeTray.instances,
    __windowInstances: () => FakeBrowserWindow.instances,
    __applicationMenu: () => applicationMenu,
    __appListenerTotal: () =>
      app.eventNames().reduce((total, name) => total + app.listenerCount(name), 0),
  };
}
