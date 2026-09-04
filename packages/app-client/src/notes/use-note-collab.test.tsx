// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as React from 'react';
import type { AppPorts, NavigationAdapter } from '../ports-context';
import { PortsProvider } from '../ports-context';
import type { EnvDescriptor, SessionView } from '@prismical/app-contracts';
import { DEFAULT_DEVICE_SETTINGS, INERT_UPDATE_STATE } from '@prismical/app-contracts';

// Capture the provider config so the test can drive its callbacks without a socket.
interface CapturedConfig {
  url: string;
  token: () => Promise<string>;
  onStatus: (d: { status: string }) => void;
  onSynced: (d: { state: boolean }) => void;
  onAuthenticated: (d: { scope: string }) => void;
  onAuthenticationFailed: (d: { reason: string }) => void;
}
let lastConfig: CapturedConfig | null = null;
const destroy = vi.fn();

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: vi.fn((config: CapturedConfig) => {
    lastConfig = config;
    return { destroy };
  }),
}));

import * as Y from 'yjs';
import type { NoteLogFlush, NoteLogHandle, NoteLogHydration, NoteLogOpenResult } from '@prismical/app-contracts';
import { configureAppClient } from '../runtime';
import { useNoteCollab } from './use-note-collab';

// The collab hook reads the note WS URL from the EnvPort, the connect token from
// the AuthPort, and org/account from the sanitized session
// view. Drive all three through a fake PortsProvider.
const fakeNavigation: NavigationAdapter = {
  useNavigation: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: <T,>() => ({}) as T,
  Link: () => null,
};
const env: EnvDescriptor = {
  noteWsUrl: 'wss://test/collaboration',
  webAppOrigin: 'https://web.test',
  analyticsKey: null,
  platform: 'web',
  appVersion: null,
};

// Mutable session the fake AuthPort serves; the org tests set it before render.
let session: SessionView = { state: 'signed-in', accounts: [], activeSub: undefined };
function signedInWithOrg(orgId: string | null): SessionView {
  return {
    state: 'signed-in',
    accounts: [{ sub: 'acct_1', email: 'a@b.co', activeOrgId: orgId ?? undefined }],
    activeSub: 'acct_1',
  };
}

const ports: AppPorts = {
  navigation: fakeNavigation,
  env: { getEnv: () => env },
  auth: {
    getSession: () => session,
    onSessionChanged: () => () => {},
    signIn: () => Promise.resolve(),
    addAccount: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    switchAccount: () => {},
    switchOrg: () => {},
    getToken: () => Promise.resolve('tok'),
    getTokenForSession: () => Promise.resolve('tok'),
  },
  assets: { resolve: p => p },
  external: {
    openAuthorizationUrl: vi.fn(),
    authorizationReturnTo: (p: string) => `https://web.test${p}`,
    openExternalUrl: vi.fn(),
  },
  desktopCapabilities: {
    has: () => false,
    featureFlags: null,
    settings: {
      get: () => Promise.resolve(DEFAULT_DEVICE_SETTINGS),
      set: () => Promise.resolve(),
      subscribe: () => () => {},
    },
    checkForUpdates: () => Promise.resolve({ status: 'disabled' }),
    getUpdateState: () => Promise.resolve(INERT_UPDATE_STATE),
    onUpdateState: () => () => {},
    restartToUpdate: () => Promise.resolve(),
    dismissUpdatePrompt: () => Promise.resolve(),
    exportLogs: () => Promise.resolve(),
    openFloatingNote: () => Promise.resolve(),
    restartApp: () => Promise.resolve(),
    resetApp: () => Promise.resolve(),
    getPermissionStatus: () =>
      Promise.resolve({ microphone: 'unavailable', systemAudio: 'unavailable' }),
    requestPermission: () =>
      Promise.resolve({ microphone: 'unavailable', systemAudio: 'unavailable' }),
    openSystemSettings: () => Promise.resolve(),
    getAppleCalendarStatus: () =>
      Promise.resolve({
        permission: 'unavailable',
        state: 'disabled',
        lastRefreshedAt: null,
        error: null,
      }),
    enableAppleCalendar: () =>
      Promise.resolve({
        permission: 'unavailable',
        state: 'disabled',
        lastRefreshedAt: null,
        error: null,
      }),
    refreshAppleCalendar: () =>
      Promise.resolve({
        permission: 'unavailable',
        state: 'disabled',
        lastRefreshedAt: null,
        error: null,
      }),
    localModels: {
      getState: () => Promise.resolve({ models: [], modelsDir: '' }),
      download: () => Promise.resolve(),
      cancelDownload: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      subscribe: () => () => {},
    },
    transcriptionByok: {
      setKey: () => Promise.resolve(),
      clearKey: () => Promise.resolve(),
      hasKey: () => Promise.resolve(false),
    },
    aiProvider: {
      setKey: () => Promise.resolve(),
      clearKey: () => Promise.resolve(),
      hasKey: () => Promise.resolve(false),
      listModels: () => Promise.resolve({ models: [], error: "unsupported" }),
    },
  },
  analytics: { capture: vi.fn(), capturePageview: vi.fn() },
  recording: { uploadTranscriptionChunk: vi.fn(() => Promise.resolve([])) },
};

function wrapper({ children }: { children: React.ReactNode }) {
  return <PortsProvider ports={ports}>{children}</PortsProvider>;
}

function render(noteId: string) {
  return renderHook(() => useNoteCollab(noteId), { wrapper });
}

beforeEach(() => {
  lastConfig = null;
  session = { state: 'signed-in', accounts: [], activeSub: undefined };
  destroy.mockClear();
  // Reset the injected runtime config — web-shaped (no noteLog) by default, so
  // the suites below exercise the byte-identical provider-only path.
  configureAppClient({ env: { getEnv: () => env } });
});

describe('useNoteCollab', () => {
  it('starts connecting with a doc, not synced, no error', () => {
    const { result } = render('note_1');
    expect(result.current.status).toBe('connecting');
    expect(result.current.synced).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.doc).not.toBeNull();
  });

  it('flips synced from the onSynced payload', () => {
    const { result } = render('note_1');
    act(() => lastConfig!.onSynced({ state: true }));
    expect(result.current.synced).toBe(true);
  });

  it('surfaces an error on onAuthenticationFailed instead of spinning forever', () => {
    const { result } = render('note_1');
    act(() => lastConfig!.onAuthenticationFailed({ reason: 'Access denied' }));
    expect(result.current.error).toBe('Access denied');
    expect(result.current.synced).toBe(false);
  });

  it('clears a prior auth error once a later reconnect syncs', () => {
    const { result } = render('note_1');
    act(() => lastConfig!.onAuthenticationFailed({ reason: 'expired' }));
    act(() => lastConfig!.onSynced({ state: true }));
    expect(result.current.error).toBeNull();
    expect(result.current.synced).toBe(true);
  });

  it('tracks connection status changes', () => {
    const { result } = render('note_1');
    act(() => lastConfig!.onStatus({ status: 'disconnected' }));
    expect(result.current.status).toBe('disconnected');
  });

  it('destroys the provider on unmount', () => {
    const { unmount } = render('note_1');
    unmount();
    expect(destroy).toHaveBeenCalled();
  });

  it('wires the token callback to the AuthPort', async () => {
    session = signedInWithOrg('org_x');
    render('note_1');
    await expect(lastConfig!.token()).resolves.toBe('tok');
  });

  it('connects without an org param when no organization is active', () => {
    render('note_1');
    expect(lastConfig!.url).toBe('wss://test/collaboration');
  });

  it('rides the active organization on the connection URL', () => {
    session = signedInWithOrg('org_x');
    render('note_1');
    expect(lastConfig!.url).toBe('wss://test/collaboration?activeOrgId=org_x');
  });

  it('defaults scope to read-write and tracks a readonly connection', () => {
    const { result } = render('note_1');
    expect(result.current.scope).toBe('read-write');
    act(() => lastConfig!.onAuthenticated({ scope: 'readonly' }));
    expect(result.current.scope).toBe('readonly');
  });

  it('reconnects when the exact login slot changes but the target sub and org do not', () => {
    session = {
      state: 'signed-in',
      accounts: [
        {
          sub: 'acct_1',
          sessionKey: 'slot_support',
          email: 'a@b.co',
          activeOrgId: 'org_x',
        },
      ],
      activeSub: 'acct_1',
      activeSessionKey: 'slot_support',
    };
    const view = render('note_1');
    const supportConfig = lastConfig;

    session = {
      state: 'signed-in',
      accounts: [
        {
          sub: 'acct_1',
          sessionKey: 'slot_ordinary',
          email: 'a@b.co',
          activeOrgId: 'org_x',
        },
      ],
      activeSub: 'acct_1',
      activeSessionKey: 'slot_ordinary',
    };
    view.rerender();

    expect(destroy).toHaveBeenCalledOnce();
    expect(lastConfig).not.toBe(supportConfig);
    expect(lastConfig?.url).toBe('wss://test/collaboration?activeOrgId=org_x');
  });
});


// ---------------------------------------------------------------------------
// Desktop note-body log lane (noteLog configured via the runtime)
// ---------------------------------------------------------------------------

const makeFakeNoteLog = () => {
  let openedResolve!: (result: NoteLogOpenResult) => void;
  let openedReject!: (error: unknown) => void;
  const opened = new Promise<NoteLogOpenResult>((resolve, reject) => {
    openedResolve = resolve;
    openedReject = reject;
  });
  let hydratedResolve!: (hydration: NoteLogHydration) => void;
  const hydrated = new Promise<NoteLogHydration>((resolve) => {
    hydratedResolve = resolve;
  });
  let updateCb: ((update: Uint8Array) => void) | null = null;
  let resyncCb: (() => void) | null = null;
  const state = {
    sent: [] as Uint8Array[],
    flushes: [] as NoteLogFlush[],
    compacts: [] as Array<{ upTo: number; state: Uint8Array }>,
    closed: false,
    openCalls: [] as string[],
  };
  const handle: NoteLogHandle = {
    opened,
    hydrated,
    onUpdate: (cb) => {
      updateCb = cb;
    },
    onResync: (cb) => {
      resyncCb = cb;
    },
    sendUpdate: (update) => {
      state.sent.push(update);
    },
    flush: (content) => {
      state.flushes.push(content);
    },
    compact: (upTo, docState) => {
      state.compacts.push({ upTo, state: docState });
    },
    close: () => {
      state.closed = true;
    },
  };
  return {
    handle,
    state,
    resolveOpened: (result: NoteLogOpenResult) => openedResolve(result),
    rejectOpened: (error: unknown) => openedReject(error),
    resolveHydrated: (hydration: NoteLogHydration) => hydratedResolve(hydration),
    emitUpdate: (update: Uint8Array) => updateCb?.(update),
    emitResync: () => resyncCb?.(),
  };
};

const configureNoteLog = (fake: ReturnType<typeof makeFakeNoteLog>, remote: boolean) => {
  configureAppClient({
    env: { getEnv: () => env },
    noteLog: {
      open: (noteId) => {
        fake.state.openCalls.push(noteId);
        return fake.handle;
      },
      remote,
    },
  });
};

/** A valid tiptap-shaped body edit on the collab fragment ('default'). */
const typeParagraph = (doc: Y.Doc, text: string) => {
  const fragment = doc.getXmlFragment('default');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
};

const encodeDocWith = (text: string): Uint8Array => {
  const source = new Y.Doc();
  typeParagraph(source, text);
  return Y.encodeStateAsUpdate(source);
};

const flushMicrotasks = () => act(async () => {});

describe('useNoteCollab with a desktop note log', () => {
  it('local mode: hydration applies replayed updates and IS the sync point — no provider', async () => {
    const fake = makeFakeNoteLog();
    configureNoteLog(fake, false);
    const { result } = render('nt_1');

    expect(fake.state.openCalls).toEqual(['nt_1']);
    await flushMicrotasks();

    // Replayed blob applies into the doc under the 'notelog' origin — and is
    // NEVER echoed back through sendUpdate.
    act(() => fake.emitUpdate(encodeDocWith('Hello')));
    expect(result.current.doc!.getXmlFragment('default').toString()).toContain('Hello');
    expect(fake.state.sent).toHaveLength(0);

    await act(async () => {
      fake.resolveOpened({ ok: true });
    });
    await act(async () => {
      fake.resolveHydrated({ seq: 2, count: 2 });
    });

    expect(result.current.status).toBe('connected');
    expect(result.current.synced).toBe(true);
    expect(result.current.scope).toBe('read-write');
    expect(result.current.error).toBeNull();
    // No HocuspocusProvider was constructed (local mode has no server).
    expect(lastConfig).toBeNull();
    // Small log — no compaction.
    expect(fake.state.compacts).toHaveLength(0);
  });

  it('forwards local edits to the log and schedules the debounced flush', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeNoteLog();
      configureNoteLog(fake, false);
      const { result } = render('nt_1');

      act(() => typeParagraph(result.current.doc!, 'First line'));
      expect(fake.state.sent).toHaveLength(1);
      expect(fake.state.flushes).toHaveLength(0); // debounced, not immediate

      act(() => vi.advanceTimersByTime(1000));
      expect(fake.state.flushes).toEqual([
        { text: 'First line', markdown: 'First line', firstLine: 'First line' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('compacts after hydrate when the replay exceeds the threshold', async () => {
    const fake = makeFakeNoteLog();
    configureNoteLog(fake, false);
    const { result } = render('nt_1');

    act(() => fake.emitUpdate(encodeDocWith('Body')));
    await act(async () => {
      fake.resolveOpened({ ok: true });
    });
    await act(async () => {
      fake.resolveHydrated({ seq: 250, count: 201 });
    });

    expect(fake.state.compacts).toHaveLength(1);
    expect(fake.state.compacts[0]!.upTo).toBe(250);
    // The compacted state is the merged doc — replaying it alone rebuilds it.
    const replayed = new Y.Doc();
    Y.applyUpdate(replayed, fake.state.compacts[0]!.state);
    expect(replayed.getXmlFragment('default').toString()).toContain('Body');
    expect(result.current.synced).toBe(true);
  });

  it('cloud mode: the provider attaches unchanged and stays the sync authority', async () => {
    const fake = makeFakeNoteLog();
    configureNoteLog(fake, true);
    const { result } = render('nt_1');

    // The provider connected exactly as before (the log is a cache beside it)…
    expect(lastConfig).not.toBeNull();
    expect(fake.state.openCalls).toEqual(['nt_1']);

    await act(async () => {
      fake.resolveOpened({ ok: true });
    });
    await act(async () => {
      fake.resolveHydrated({ seq: 1, count: 1 });
    });
    // …and log hydration does NOT claim synced — only the provider may.
    expect(result.current.synced).toBe(false);
    act(() => lastConfig!.onSynced({ state: true }));
    expect(result.current.synced).toBe(true);
  });

  it('local mode: an open failure surfaces the error and NEVER dials the cloud provider', async () => {
    const fake = makeFakeNoteLog();
    configureNoteLog(fake, false);
    const { result } = render('nt_1');

    expect(lastConfig).toBeNull();
    await act(async () => {
      fake.resolveOpened({ error: { code: 'NO_WORKSPACE' } });
    });
    // A mode whose premise is "no server" must not open a socket to the
    // packaged cloud collab URL — no HocuspocusProvider is ever constructed…
    expect(lastConfig).toBeNull();
    // …the failure is surfaced instead (NoteBodyEditor renders its lock card).
    expect(result.current.status).toBe('disconnected');
    expect(result.current.synced).toBe(false);
    expect(result.current.error).toBeTruthy();
  });

  it('local mode: a REJECTED open also surfaces the error without a provider', async () => {
    const fake = makeFakeNoteLog();
    configureNoteLog(fake, false);
    const { result } = render('nt_1');

    await act(async () => {
      fake.rejectOpened(new Error('invoke failed'));
    });
    expect(lastConfig).toBeNull();
    expect(result.current.error).toBeTruthy();
  });

  it('flushes at the max-wait ceiling while continuous typing re-arms the debounce', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeNoteLog();
      configureNoteLog(fake, false);
      const { result } = render('nt_1');

      // One update every 900ms: the 1s debounce alone would never fire.
      for (let i = 0; i < 7; i++) {
        act(() => typeParagraph(result.current.doc!, `line ${i}`));
        act(() => vi.advanceTimersByTime(900));
      }

      expect(fake.state.flushes).toHaveLength(1);
      expect(fake.state.flushes[0]!.text).toContain('line 5');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resync heals the gap by compacting a full state snapshot at the hydrated seq', async () => {
    const fake = makeFakeNoteLog();
    configureNoteLog(fake, false);
    const { result } = render('nt_1');

    await act(async () => {
      fake.resolveOpened({ ok: true });
    });
    await act(async () => {
      fake.resolveHydrated({ seq: 7, count: 3 });
    });
    act(() => typeParagraph(result.current.doc!, 'Durable'));

    await act(async () => {
      fake.emitResync();
    });

    expect(fake.state.compacts).toHaveLength(1);
    expect(fake.state.compacts[0]!.upTo).toBe(7);
    // The snapshot alone rebuilds the doc — replaying it repairs the gap.
    const replayed = new Y.Doc();
    Y.applyUpdate(replayed, fake.state.compacts[0]!.state);
    expect(replayed.getXmlFragment('default').toString()).toContain('Durable');
    expect(result.current.error).toBeNull();
  });

  it('resync heals at most once per interval and surfaces the error after three', async () => {
    const fake = makeFakeNoteLog();
    configureNoteLog(fake, false);
    const { result } = render('nt_1');

    await act(async () => {
      fake.resolveOpened({ ok: true });
    });
    await act(async () => {
      fake.resolveHydrated({ seq: 2, count: 1 });
    });

    await act(async () => {
      fake.emitResync(); // heals
    });
    await act(async () => {
      fake.emitResync(); // throttled — one heal per 2s
    });
    expect(fake.state.compacts).toHaveLength(1);
    expect(result.current.error).toBeNull();

    await act(async () => {
      fake.emitResync(); // three in a row: writes are persistently failing
    });
    expect(fake.state.compacts).toHaveLength(1);
    expect(result.current.error).toBeTruthy();
  });

  it('cloud mode: a persistently failing cache degrades quietly (the provider is authority)', async () => {
    const fake = makeFakeNoteLog();
    configureNoteLog(fake, true);
    const { result } = render('nt_1');

    await act(async () => {
      fake.resolveOpened({ ok: true });
    });
    await act(async () => {
      fake.resolveHydrated({ seq: 1, count: 1 });
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        fake.emitResync();
      });
    }

    // A broken offline cache must never replace a working editor with a lock card.
    expect(result.current.error).toBeNull();
  });

  it('cleanup flushes dirty edits, closes the handle, and still destroys the doc', async () => {
    const fake = makeFakeNoteLog();
    configureNoteLog(fake, false);
    const { result, unmount } = render('nt_1');

    act(() => typeParagraph(result.current.doc!, 'Unsaved'));
    expect(fake.state.flushes).toHaveLength(0);

    unmount();
    expect(fake.state.flushes).toEqual([
      { text: 'Unsaved', markdown: 'Unsaved', firstLine: 'Unsaved' },
    ]);
    expect(fake.state.closed).toBe(true);
  });
});
