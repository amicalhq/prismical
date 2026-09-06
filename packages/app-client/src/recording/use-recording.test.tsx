// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  AuthPort,
  NativeRecordingControl,
  NativeRecordingState,
  NativeStartResult,
} from '@prismical/app-contracts';
import { DEFAULT_DEVICE_SETTINGS, INERT_UPDATE_STATE } from '@prismical/app-contracts';
import type { AppPorts, NavigationAdapter } from '../ports-context';
import { PortsProvider } from '../ports-context';
import {
  abandonStaging,
  completeStaging,
  createRecording,
  finalizeRecording,
  getTranscriptionSettings,
  mintStagingUrls,
} from '../api/transcription';
import { useRecording } from './use-recording';
import { organizationsKey } from '../api/hooks/organizations';
import { listPendingStagingRecoveries, savePendingStagingRecovery } from './staging-buffer';
import { ApiError } from '../api/client';
import { useAutoEnhanceStore } from '../notes/auto-enhance-store';
import { setRecordingPreferences } from './recording-preferences';

const stopAfterTest: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await act(async () => {
    for (const stop of stopAfterTest.splice(0)) await stop();
  });
  cleanup();
});

const STABLE_SESSION = {
  state: 'signed-in',
  accounts: [{ sub: 'user_1', activeOrgId: 'org_1' }],
  activeSub: 'user_1',
} as unknown as ReturnType<AppPorts['auth']['getSession']>;

// The desktop record button routes through RecordingPort.control: start/
// stop go to main over IPC and the live segments arrive via the pushed
// RecordingState. This drives that native branch through a fake control port —
// no MediaRecorder, no IPC — proving useRecording mirrors the pushed state into
// the SAME dock/transcript surface the web path drives.
//
// The web-branch suite below fakes just enough of the audio stack (getUserMedia,
// AudioContext, AudioWorkletNode) to drive the worklet-frame pipeline by hand and
// pin down pause/resume: the partial chunk flushes at pause, the
// context suspends, and resume continues the SAME chunk counter and media
// timeline — no gap, no restart.

vi.mock('../api/transcription', () => ({
  createRecording: vi.fn(async () => ({ id: 'rec_web', startedAt: '2026-07-18T00:00:00.000Z' })),
  finalizeRecording: vi.fn(async () => {}),
  getTranscriptionSettings: vi.fn(async () => ({ liveTranscription: true })),
  mintStagingUrls: vi.fn(async () => ({ uploads: [] })),
  completeStaging: vi.fn(async () => {}),
  abandonStaging: vi.fn(async () => {}),
}));
vi.mock('../api/hooks/model-defaults', () => ({
  ensureModelDefault: vi.fn(async () => ({})),
}));

const fakeNavigation: NavigationAdapter = {
  useNavigation: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: <T,>() => ({}) as T,
  Link: () => null,
};

const idle: NativeRecordingState = {
  recordingId: null,
  status: 'idle',
  captureMode: null,
  requestedCaptureMode: null,
  micSource: 'system-default',
  noteId: null,
  segments: [],
  elapsedMs: 0,
};

function makeFakeControl() {
  let listener: ((state: NativeRecordingState) => void) | null = null;
  const startCalls: Array<{ noteId: string | null; title: string }> = [];
  const stopCalls: string[] = [];
  const pauseCalls: string[] = [];
  const resumeCalls: string[] = [];
  let startResult: NativeStartResult = { ok: true, recordingId: 'rec_1' };
  const control: NativeRecordingControl = {
    claimCompletion: vi.fn(async () => true),
    start: async input => {
      startCalls.push(input);
      return startResult;
    },
    stop: async id => {
      stopCalls.push(id);
    },
    pause: async id => {
      pauseCalls.push(id);
      return true;
    },
    resume: async id => {
      resumeCalls.push(id);
      return true;
    },
    subscribe: l => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  return {
    control,
    startCalls,
    stopCalls,
    pauseCalls,
    resumeCalls,
    setStartResult: (r: NativeStartResult) => {
      startResult = r;
    },
    push: (state: NativeRecordingState) => act(() => listener?.(state)),
  };
}

function makePorts(
  recording: AppPorts['recording'],
  auth: AuthPort = {
    getSession: () => STABLE_SESSION,
    onSessionChanged: () => () => {},
    signIn: () => Promise.resolve(),
    addAccount: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    switchAccount: () => {},
    switchOrg: () => {},
    getToken: () => Promise.resolve('tok'),
    getTokenForSession: () => Promise.resolve('tok'),
  }
): AppPorts {
  return {
    navigation: fakeNavigation,
    env: {
      getEnv: () => ({
        noteWsUrl: 'wss://test/collaboration',
        webAppOrigin: 'https://web.test',
        analyticsKey: null,
        platform: 'desktop',
        appVersion: null,
      }),
    },
    auth,
    assets: { resolve: (p: string) => p },
    external: {
      openAuthorizationUrl: vi.fn(),
      authorizationReturnTo: (p: string) => `https://web.test${p}`,
      openExternalUrl: vi.fn(),
    },
    desktopCapabilities: {
      has: () => true,
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
        listModels: () => Promise.resolve({ models: [], error: 'unsupported' }),
      },
    },
    analytics: { capture: vi.fn(), capturePageview: vi.fn() },
    recording,
  };
}

function renderWithPorts(
  recording: AppPorts['recording'],
  /** Seeds the org-list cache readAutoPausePolicy reads; absent ⇒ auto-pause off. */
  autoPause?: {
    silenceSeconds: number;
    graceSeconds: number;
    autoStopAfterPausedMinutes?: number;
  },
  auth?: AuthPort,
  handleCompletion = true
) {
  const qc = new QueryClient();
  if (autoPause) {
    qc.setQueryData(organizationsKey, [
      {
        orgUserId: 'ou_1',
        orgId: 'org_1',
        name: 'Test',
        slug: 'test',
        role: 'owner',
        allowPublicSharing: true,
        features: { autoPauseOnSilence: true },
        transcription: {
          autoPauseSilenceSeconds: autoPause.silenceSeconds,
          autoPauseGraceSeconds: autoPause.graceSeconds,
          autoStopAfterPausedMinutes: autoPause.autoStopAfterPausedMinutes ?? 20,
        },
        memberCount: 1,
      },
    ]);
  }
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <PortsProvider ports={makePorts(recording, auth)}>{children}</PortsProvider>
    </QueryClientProvider>
  );
  const rendered = renderHook(() => useRecording({ handleCompletion }), { wrapper });
  stopAfterTest.push(() => rendered.result.current.stop());
  return rendered;
}

function mutableAuth(initialView: ReturnType<AuthPort['getSession']>) {
  let view = initialView;
  const contextOf = (next: ReturnType<AuthPort['getSession']>) => {
    const sessionKey = next.activeSessionKey ?? next.activeSub ?? null;
    const account = next.accounts.find(
      candidate => (candidate.sessionKey ?? candidate.sub) === sessionKey
    );
    return {
      sessionKey,
      orgId: account?.activeOrgId ?? null,
      token: sessionKey === 'support_session_1' ? 'support-token' : 'ordinary-token',
    };
  };
  let credentialContext = contextOf(initialView);
  const listeners = new Set<(next: ReturnType<AuthPort['getSession']>) => void>();
  const auth: AuthPort = {
    getSession: () => view,
    onSessionChanged: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signIn: () => Promise.resolve(),
    addAccount: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    switchAccount: () => {},
    switchOrg: () => {},
    getToken: () =>
      Promise.resolve(
        view.activeSessionKey === 'support_session_1' ? 'support-token' : 'ordinary-token'
      ),
    getTokenForSession: (expectedSessionKey, expectedOrgId) =>
      Promise.resolve(
        credentialContext.sessionKey === expectedSessionKey &&
          (expectedOrgId === undefined || credentialContext.orgId === expectedOrgId)
          ? credentialContext.token
          : null
      ),
  };
  return {
    auth,
    setView(next: ReturnType<AuthPort['getSession']>) {
      view = next;
      credentialContext = contextOf(next);
      act(() => {
        for (const listener of listeners) listener(view);
      });
    },
    setCredentialContext(sessionKey: string, orgId: string | null, token: string) {
      credentialContext = { sessionKey, orgId, token };
    },
  };
}

function renderRecording(control: NativeRecordingControl) {
  return renderWithPorts({
    uploadTranscriptionChunk: vi.fn(() => {
      throw new Error('web-only');
    }),
    control,
  });
}

const segment = {
  id: 'tsg_0',
  recordingId: 'rec_1',
  source: 'mic',
  speaker: 'you',
  text: 'hello from native',
  startTimeMs: 0,
  endTimeMs: 5000,
  segmentOrder: 1_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  useAutoEnhanceStore.getState().clear();
});

describe('useRecording — native (desktop) branch', () => {
  it('routes start to control.start and mirrors the pushed recording state into live segments', async () => {
    const fake = makeFakeControl();
    const { result } = renderRecording(fake.control);

    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    // The record button reached main's pipeline (no MediaRecorder), title threaded.
    expect(fake.startCalls).toEqual([{ noteId: 'note_1', title: 'Standup' }]);
    expect(result.current.recordingId).toBe('rec_1');

    // Main pushes 'recording' with a transcript segment → the dock lights up.
    fake.push({
      ...idle,
      recordingId: 'rec_1',
      status: 'recording',
      captureMode: 'dual',
      requestedCaptureMode: 'dual',
      micSource: 'meeting-app',
      noteId: 'note_1',
      segments: [segment],
      elapsedMs: 5000,
      startedAt: Date.parse('2026-07-18T00:00:00.000Z'),
    });
    expect(result.current.isRecording).toBe(true);
    expect(result.current.liveSegments).toEqual([segment]);
    expect(result.current.error).toBeNull();
    expect(result.current.startedAt).toBe('2026-07-18T00:00:00.000Z');
  });

  it('claims externally stopped native completion with its immutable note owner', async () => {
    const fake = makeFakeControl();
    const { result } = renderRecording(fake.control);
    fake.push({
      ...idle,
      status: 'idle',
      recordingId: 'rec_native',
      noteId: 'note_owner',
      segments: [],
    });
    await waitFor(() =>
      expect(result.current.completedRecording).toEqual({
        recordingId: 'rec_native',
        noteId: 'note_owner',
        segments: 0,
        ownerSessionKey: 'user_1',
        ownerOrgId: 'org_1',
      })
    );
    expect(result.current.noteId).toBe('note_owner');
    expect(fake.control.claimCompletion).toHaveBeenCalledWith('rec_native');
  });

  it('allows passive native observers without taking the completion claim', async () => {
    const fake = makeFakeControl();
    const { result } = renderWithPorts(
      { control: fake.control, uploadTranscriptionChunk: vi.fn() },
      undefined,
      undefined,
      false
    );
    fake.push({ ...idle, status: 'idle', recordingId: 'rec_native', noteId: 'note_owner' });
    await act(async () => {});
    expect(fake.control.claimCompletion).not.toHaveBeenCalled();
    expect(result.current.completedRecording).toBeNull();
  });

  it('does not publish completion when another native window owns it', async () => {
    const fake = makeFakeControl();
    vi.mocked(fake.control.claimCompletion).mockResolvedValue(false);
    const { result } = renderRecording(fake.control);
    fake.push({ ...idle, status: 'error', recordingId: 'rec_native', noteId: 'note_owner' });
    await act(async () => {});
    expect(fake.control.claimCompletion).toHaveBeenCalledWith('rec_native');
    expect(result.current.completedRecording).toBeNull();
    expect(result.current.error).toBe('recording.errors.endedUnexpectedly');
  });

  it('retains completion work when the native claim resolves after unmount', async () => {
    const fake = makeFakeControl();
    let grant!: (claimed: boolean) => void;
    vi.mocked(fake.control.claimCompletion).mockImplementation(
      () =>
        new Promise(resolve => {
          grant = resolve;
        })
    );
    const { unmount } = renderRecording(fake.control);
    fake.push({ ...idle, recordingId: 'rec_native', noteId: 'note_owner' });
    unmount();
    await act(async () => {
      grant(true);
    });
    expect(useAutoEnhanceStore.getState().requests).toEqual([
      {
        recordingId: 'rec_native',
        noteId: 'note_owner',
        ownerSessionKey: 'user_1',
        ownerOrgId: 'org_1',
        source: 'auto-enhance',
      },
    ]);
  });

  it('routes stop while the native session is starting', async () => {
    const fake = makeFakeControl();
    const { result } = renderRecording(fake.control);
    fake.push({ ...idle, status: 'starting', recordingId: 'rec_native', noteId: 'note_owner' });
    await act(async () => {
      await result.current.stop();
    });
    expect(fake.stopCalls).toEqual(['rec_native']);
  });

  it('surfaces the mic-only notice when the gate degrades dual → mic', async () => {
    const fake = makeFakeControl();
    const { result } = renderRecording(fake.control);
    fake.push({
      ...idle,
      recordingId: 'rec_1',
      status: 'recording',
      captureMode: 'mic',
      requestedCaptureMode: 'dual',
      micSource: 'system-default',
      noteId: 'note_1',
      segments: [],
      elapsedMs: 0,
    });
    expect(result.current.error).toBe('recording.errors.systemAudioUnavailable');
  });

  it('surfaces the mic recovery notice with system-audio reassurance only in dual mode', () => {
    const fake = makeFakeControl();
    const { result } = renderRecording(fake.control);

    fake.push({
      ...idle,
      recordingId: 'rec_1',
      status: 'recording',
      captureMode: 'dual',
      requestedCaptureMode: 'dual',
      micSource: 'unavailable',
    });
    expect(result.current.error).toBe('recording.errors.noMicrophoneSystemAudioContinues');

    fake.push({
      ...idle,
      recordingId: 'rec_1',
      status: 'recording',
      captureMode: 'mic',
      requestedCaptureMode: 'dual',
      micSource: 'unavailable',
    });
    expect(result.current.error).toBe('recording.errors.noMicrophone');
  });

  it('keeps native notice precedence error > mic unavailable > system-audio degrade', () => {
    const fake = makeFakeControl();
    const { result } = renderRecording(fake.control);
    fake.push({
      ...idle,
      recordingId: 'rec_1',
      status: 'error',
      captureMode: 'mic',
      requestedCaptureMode: 'dual',
      micSource: 'unavailable',
    });
    expect(result.current.error).toBe('recording.errors.endedUnexpectedly');
  });

  it('renders no notice for normal mic alignment transitions', () => {
    const fake = makeFakeControl();
    const { result } = renderRecording(fake.control);
    const recordingState: NativeRecordingState = {
      ...idle,
      recordingId: 'rec_1',
      status: 'recording',
      captureMode: 'dual',
      requestedCaptureMode: 'dual',
      micSource: 'meeting-app',
    };
    fake.push(recordingState);
    expect(result.current.error).toBeNull();
    fake.push({ ...recordingState, micSource: 'system-default' });
    expect(result.current.error).toBeNull();
  });

  it('surfaces the mic-denied error and stays idle when start is permission-denied', async () => {
    const fake = makeFakeControl();
    fake.setStartResult({ ok: false, reason: 'permission-denied' });
    const { result } = renderRecording(fake.control);
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    expect(result.current.error).toBe('recording.errors.microphoneDenied');
    expect(result.current.isRecording).toBe(false);
    expect(result.current.state).toBe('idle');
    // Main keeps pushing its (idle, notice-free) state after the failed start; the reason the
    // start failed must survive those pushes, not vanish on the next one.
    fake.push({ ...idle });
    expect(result.current.error).toBe('recording.errors.microphoneDenied');
    // A notice main itself implies still replaces it, and clears once main is back to normal.
    fake.push({
      ...idle,
      recordingId: 'rec_1',
      status: 'recording',
      captureMode: 'mic',
      requestedCaptureMode: 'dual',
      micSource: 'system-default',
    });
    expect(result.current.error).toBe('recording.errors.systemAudioUnavailable');
    fake.push({ ...idle, status: 'recording', captureMode: 'dual', requestedCaptureMode: 'dual' });
    expect(result.current.error).toBeNull();
  });

  it('routes stop from paused to control.stop and reports the live segment count', async () => {
    const fake = makeFakeControl();
    const { result } = renderRecording(fake.control);
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    fake.push({
      ...idle,
      recordingId: 'rec_1',
      status: 'paused',
      captureMode: 'dual',
      requestedCaptureMode: 'dual',
      micSource: 'meeting-app',
      noteId: 'note_1',
      segments: [segment],
      elapsedMs: 5000,
    });
    let stopped: { segments: number } | undefined;
    await act(async () => {
      stopped = await result.current.stop();
    });
    expect(fake.stopCalls).toEqual(['rec_1']);
    expect(stopped).toEqual({ segments: 1 });
  });

  it('routes pause/resume to native control and mirrors the paused state', async () => {
    const fake = makeFakeControl();
    const { result } = renderRecording(fake.control);
    fake.push({
      ...idle,
      recordingId: 'rec_1',
      status: 'recording',
      captureMode: 'dual',
      requestedCaptureMode: 'dual',
      micSource: 'meeting-app',
      noteId: 'note_1',
      segments: [],
      elapsedMs: 0,
    });
    expect(result.current.canPause).toBe(true);
    let paused = false;
    await act(async () => {
      paused = await result.current.pause();
    });
    expect(paused).toBe(true);
    expect(fake.pauseCalls).toEqual(['rec_1']);
    fake.push({
      ...idle,
      recordingId: 'rec_1',
      status: 'paused',
      captureMode: 'dual',
      requestedCaptureMode: 'dual',
      micSource: 'meeting-app',
      noteId: 'note_1',
    });
    expect(result.current.state).toBe('paused');
    expect(result.current.isPaused).toBe(true);

    let resumed = false;
    await act(async () => {
      resumed = await result.current.resume();
    });
    expect(resumed).toBe(true);
    expect(fake.resumeCalls).toEqual(['rec_1']);
    fake.push({
      ...idle,
      recordingId: 'rec_1',
      status: 'recording',
      captureMode: 'dual',
      requestedCaptureMode: 'dual',
      micSource: 'meeting-app',
      noteId: 'note_1',
    });
    expect(result.current.state).toBe('recording');
    expect(result.current.error).toBeNull();
  });
});

// --- Web branch: pause/resume -----------------------------------------------

function makeFakeWebLocks() {
  const held = new Set<string>();
  const request = vi.fn(
    (
      name: string,
      optionsOrCallback: unknown,
      suppliedCallback?: (lock: unknown) => Promise<unknown>
    ) => {
      const callback = (suppliedCallback ?? optionsOrCallback) as (
        lock: unknown
      ) => Promise<unknown>;
      if (held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      return Promise.resolve()
        .then(() => callback({ name }))
        .finally(() => held.delete(name));
    }
  );
  return { held, request };
}

class FakeWorkletPort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  posted: Array<{ type?: string }> = [];
  postMessage(msg: { type?: string }) {
    this.posted.push(msg);
  }
  close() {}
}

class FakeWorkletNode {
  static last: FakeWorkletNode | null = null;
  port = new FakeWorkletPort();
  constructor() {
    FakeWorkletNode.last = this;
  }
  disconnect() {}
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  audioWorklet = { addModule: vi.fn(async () => {}) };
  suspend = vi.fn(async () => {});
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  constructor() {
    FakeAudioContext.last = this;
  }
}

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  state: RecordingState = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() {}
  start() {
    this.state = 'recording';
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  stop() {
    this.ondataavailable?.({ data: new Blob(['audio']) } as BlobEvent);
    this.state = 'inactive';
    this.onstop?.();
  }
}

/** Deliver one silent worklet frame of `samples` samples to the hook's pipeline. */
function pushFrame(samples: number) {
  act(() => {
    FakeWorkletNode.last?.port.onmessage?.({
      data: { type: 'audioFrame', frame: new Float32Array(samples) },
    } as MessageEvent);
  });
}

describe('useRecording — web branch pause/resume', () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  let locks: ReturnType<typeof makeFakeWebLocks>;
  let upload: ReturnType<typeof vi.fn>;

  let originalMediaDevices: PropertyDescriptor | undefined;
  let originalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    locks = makeFakeWebLocks();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({}))
    );
    originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        enumerateDevices: vi.fn(async () => [
          { kind: 'audioinput', deviceId: 'mic_external', label: 'External mic' },
        ]),
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
      configurable: true,
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
    upload = vi.fn(async () => []);
  });

  afterEach(() => {
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else delete (navigator as { locks?: unknown }).locks;
    vi.unstubAllGlobals();
    // unstubAllGlobals doesn't undo defineProperty — restore navigator ourselves.
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    } else {
      delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
    if (originalStorage) {
      Object.defineProperty(navigator, 'storage', originalStorage);
    } else {
      delete (navigator as { storage?: unknown }).storage;
    }
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  const renderWeb = () => renderWithPorts({ uploadTranscriptionChunk: upload });

  function installRecoveryFile() {
    const removeEntry = vi.fn(async () => {});
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: vi.fn(async () => ({
          getFileHandle: vi.fn(async () => ({
            getFile: vi.fn(async () => new File(['deferred audio'], 'staging-rec_recovery')),
          })),
          removeEntry,
        })),
      },
    });
    return removeEntry;
  }

  function installDurableStagingFile() {
    const removeEntry = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: vi.fn(async () => ({
          getFileHandle: vi.fn(async () => ({
            createWritable: vi.fn(async () => ({ write, close })),
            getFile: vi.fn(async () => new File(['deferred audio'], 'staging-rec_web')),
          })),
          removeEntry,
        })),
      },
    });
    return { removeEntry, write, close };
  }

  it('ignores a resume that resolves after the recording stopped', async () => {
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    await act(async () => {
      await result.current.pause();
    });
    let release!: () => void;
    FakeAudioContext.last!.resume.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    );
    let resuming!: Promise<boolean>;
    act(() => {
      resuming = result.current.resume();
    });
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.state).toBe('idle');
    await act(async () => {
      release();
      await resuming;
    });
    expect(result.current.state).toBe('idle');
  });

  it('ended microphone during opening must not leave recording active', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
      getTracks: () => [{ stop: vi.fn(), readyState: 'ended', addEventListener: vi.fn() }],
    } as unknown as MediaStream);
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
    });
    expect(result.current.error).toBe('recording.errors.microphoneDisconnected');
    expect(result.current.state).toBe('idle');
    expect(finalizeRecording).toHaveBeenCalledTimes(1);
    expect(result.current.completedRecording?.noteId).toBe('note_1');
  });

  it('an unmounted pending start must release its late microphone', async () => {
    let release!: (stream: MediaStream) => void;
    const stopTrack = vi.fn();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    );
    const { result, unmount } = renderWeb();
    let starting!: Promise<void>;
    act(() => {
      starting = result.current.start('note_1', 'Standup');
    });
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      release({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
      await starting;
    });
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it('failed context suspension must resume the staging recorder', async () => {
    class InspectRecorder extends FakeMediaRecorder {
      static last: InspectRecorder;
      constructor() {
        super();
        InspectRecorder.last = this;
      }
    }
    vi.stubGlobal('MediaRecorder', InspectRecorder);
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    FakeAudioContext.last!.suspend.mockRejectedValue(new Error('suspend failed'));
    await act(async () => {
      expect(await result.current.pause()).toBe(false);
    });
    expect(result.current.state).toBe('recording');
    expect(InspectRecorder.last.state).toBe('recording');
  });

  it('two starts in the same render must allocate only one recording', async () => {
    const { result } = renderWeb();
    await act(async () => {
      await Promise.all([
        result.current.start('note_1', 'Standup'),
        result.current.start('note_1', 'Standup'),
      ]);
    });
    expect(createRecording).toHaveBeenCalledTimes(1);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('retries live finalization without staging and reports completion for its owner note', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    vi.mocked(finalizeRecording).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_owner', 'Standup');
    });
    pushFrame(16000);
    await act(async () => {
      await result.current.stop();
    });
    await waitFor(() => expect(finalizeRecording).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listPendingStagingRecoveries()).toEqual([]));
    expect(finalizeRecording).toHaveBeenLastCalledWith(
      'rec_web',
      1000,
      false,
      false,
      expect.objectContaining({ activeOrgId: 'org_1' })
    );
    expect(result.current.completedRecording).toEqual({
      recordingId: 'rec_web',
      noteId: 'note_owner',
      segments: 0,
      ownerSessionKey: 'user_1',
      ownerOrgId: 'org_1',
    });
  });

  it('retains live audio across failed finalization and retries staging', async () => {
    installDurableStagingFile();
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.mocked(finalizeRecording).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(mintStagingUrls).mockResolvedValueOnce({
      uploads: [
        {
          lane: 'mic',
          objectName: 'audio',
          url: 'https://upload.test',
          headers: {},
        },
      ],
      expiresAt: new Date().toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200 }))
    );
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_owner', 'Standup');
    });
    pushFrame(16000);
    await act(async () => {
      await result.current.stop();
    });
    await waitFor(() => expect(completeStaging).toHaveBeenCalledTimes(1));
    expect(listPendingStagingRecoveries()).toEqual([]);
    expect(finalizeRecording).toHaveBeenCalledTimes(2);
  });

  it('joins duplicate stop calls and publishes completion once', async () => {
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_owner', 'Standup');
    });
    await act(async () => {
      await Promise.all([result.current.stop(), result.current.stop()]);
    });
    expect(finalizeRecording).toHaveBeenCalledTimes(1);
    expect(result.current.completedRecording).toEqual({
      recordingId: 'rec_web',
      noteId: 'note_owner',
      segments: 0,
      ownerSessionKey: 'user_1',
      ownerOrgId: 'org_1',
    });
  });

  it('holds the recovery lock until local audio closes after finalization fails', async () => {
    const file = installDurableStagingFile();
    let closeAudio!: () => void;
    file.close.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          closeAudio = resolve;
        })
    );
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.mocked(finalizeRecording).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_owner', 'Standup');
    });
    let stopped!: Promise<{ segments: number }>;
    act(() => {
      stopped = result.current.stop();
    });
    await waitFor(() => expect(finalizeRecording).toHaveBeenCalledOnce());
    await waitFor(() => expect(file.close).toHaveBeenCalledOnce());
    const lockName = 'prismical-recording-recovery:rec_web';
    expect(locks.held.has(lockName)).toBe(true);
    expect(result.current.state).toBe('stopping');
    await act(async () => {
      closeAudio();
      await stopped;
    });
    await waitFor(() => expect(finalizeRecording).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(locks.held.has(lockName)).toBe(false));
    expect(listPendingStagingRecoveries()[0]?.needsFinalize).toBe(false);
    expect(result.current.state).toBe('idle');
  });

  it('persists the stop intent before waiting for active uploads', async () => {
    let completeUpload!: () => void;
    upload.mockImplementationOnce(() =>
      new Promise<void>(resolve => {
        completeUpload = resolve;
      }).then(() => [])
    );
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_owner', 'Standup');
    });
    pushFrame(16000);
    await act(async () => {});
    let stopped!: Promise<{ segments: number }>;
    act(() => {
      stopped = result.current.stop();
    });
    await waitFor(() =>
      expect(listPendingStagingRecoveries()).toEqual([
        expect.objectContaining({
          recordingId: 'rec_web',
          noteId: 'note_owner',
          needsFinalize: true,
          durationMs: 1000,
        }),
      ])
    );
    expect(finalizeRecording).not.toHaveBeenCalled();
    await act(async () => {
      completeUpload();
      await stopped;
    });
    expect(finalizeRecording).toHaveBeenCalledOnce();
  });

  it('waits for another tab to release its recording recovery lock', async () => {
    const lockName = 'prismical-recording-recovery:rec_locked';
    locks.held.add(lockName);
    savePendingStagingRecovery({
      version: 2,
      recordingId: 'rec_locked',
      noteId: 'note_owner',
      contentType: 'audio/webm',
      durationMs: 1000,
      endedAt: Date.now() - 120000,
      createdAt: Date.now() - 120000,
      ownerSub: 'user_1',
      ownerOrgId: 'org_1',
      ownerSessionKey: 'user_1',
      transcriptionDeferred: false,
      expectsStaging: false,
      needsFinalize: true,
      action: 'upload',
    });
    renderWeb();
    await act(async () => {});
    expect(finalizeRecording).not.toHaveBeenCalled();
    expect(locks.request).toHaveBeenCalledWith(
      lockName,
      { ifAvailable: true },
      expect.any(Function)
    );
    locks.held.delete(lockName);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(finalizeRecording).toHaveBeenCalledOnce());
    await waitFor(() => expect(listPendingStagingRecoveries()).toEqual([]));
  });

  it('publishes a stop intent only after draining when Web Locks are unavailable', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    let completeUpload!: () => void;
    upload.mockImplementationOnce(() =>
      new Promise<void>(resolve => {
        completeUpload = resolve;
      }).then(() => [])
    );
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_owner', 'Standup');
    });
    pushFrame(16000);
    await act(async () => {});
    let stopped!: Promise<{ segments: number }>;
    act(() => {
      stopped = result.current.stop();
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 180));
    });
    expect(listPendingStagingRecoveries()).toEqual([]);
    expect(finalizeRecording).not.toHaveBeenCalled();
    await act(async () => {
      completeUpload();
      await stopped;
    });
    expect(finalizeRecording).toHaveBeenCalledOnce();
  });

  it('uses the selected language and microphone for the next recording', async () => {
    setRecordingPreferences({
      autoDetectLanguage: false,
      language: 'es',
      microphonePriority: [{ deviceId: 'mic_external', name: 'External mic' }],
    });
    const { result } = renderWeb();

    await act(async () => {
      await result.current.start('note_1', 'Spanish interview');
    });

    expect(createRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        noteId: 'note_1',
        title: 'Spanish interview',
        language: 'es',
      }),
      { activeOrgId: 'org_1', authToken: 'tok' }
    );
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: 'mic_external' } }),
    });
  });

  it('falls back to the default microphone when a preferred device disappears', async () => {
    setRecordingPreferences({
      microphonePriority: [{ deviceId: 'mic_gone', name: 'Missing mic' }],
    });
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValueOnce([
      { kind: 'audioinput', deviceId: 'mic_gone', label: 'Missing mic' } as MediaDeviceInfo,
    ]);
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockRejectedValueOnce({ name: 'OverconstrainedError' })
      .mockResolvedValueOnce({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream);
    const { result } = renderWeb();

    await act(async () => {
      await result.current.start('note_1', 'Fallback test');
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({
      audio: expect.not.objectContaining({ deviceId: expect.anything() }),
    });
    expect(window.localStorage.getItem('prismical:recording-preferences:v1')).toContain(
      '"deviceId":"mic_gone"'
    );
  });

  it('retries a persisted deferred upload on launch and clears its OPFS recovery artifact', async () => {
    const removeEntry = installRecoveryFile();
    savePendingStagingRecovery({
      version: 2,
      recordingId: 'rec_recovery',
      contentType: 'audio/webm',
      durationMs: 30_000,
      endedAt: Date.now() - 120_000,
      createdAt: Date.now() - 120_000,
      ownerSub: 'user_1',
      ownerOrgId: 'org_1',
      ownerSessionKey: 'user_1',
      transcriptionDeferred: true,
      needsFinalize: false,
      action: 'upload',
    });
    vi.mocked(mintStagingUrls).mockResolvedValueOnce({
      uploads: [
        {
          lane: 'mic',
          objectName: 'recordings/rec_recovery/mic.webm',
          url: 'https://upload.test',
          headers: { 'Content-Type': 'audio/webm' },
        },
      ],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async input =>
        input === '/audio-recorder-processor.js'
          ? ({} as Response)
          : ({ ok: true, status: 200 } as Response)
      )
    );

    renderWeb();

    await waitFor(() =>
      expect(completeStaging).toHaveBeenCalledWith(
        'rec_recovery',
        [{ lane: 'mic', contentType: 'audio/webm', durationMs: 30_000 }],
        'org_1',
        'tok'
      )
    );
    expect(listPendingStagingRecoveries()).toEqual([]);
    expect(removeEntry).toHaveBeenCalledWith('staging-rec_recovery');
    expect(abandonStaging).not.toHaveBeenCalled();
  });

  it('keeps deferred recovery pending while offline, then resumes it on the online event', async () => {
    installRecoveryFile();
    savePendingStagingRecovery({
      version: 2,
      recordingId: 'rec_offline',
      contentType: 'audio/webm',
      durationMs: 30_000,
      endedAt: Date.now() - 120_000,
      createdAt: Date.now() - 120_000,
      ownerSub: 'user_1',
      ownerOrgId: 'org_1',
      ownerSessionKey: 'user_1',
      transcriptionDeferred: true,
      needsFinalize: false,
      action: 'upload',
    });
    vi.mocked(mintStagingUrls)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        uploads: [
          {
            lane: 'mic',
            objectName: 'recordings/rec_offline/mic.webm',
            url: 'https://upload.test',
            headers: { 'Content-Type': 'audio/webm' },
          },
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async input =>
        input === '/audio-recorder-processor.js'
          ? ({} as Response)
          : ({ ok: true, status: 200 } as Response)
      )
    );
    renderWeb();

    await waitFor(() => expect(mintStagingUrls).toHaveBeenCalledTimes(1));
    expect(listPendingStagingRecoveries()).toHaveLength(1);
    expect(abandonStaging).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('online'));

    await waitFor(() => expect(completeStaging).toHaveBeenCalledTimes(1));
    expect(listPendingStagingRecoveries()).toEqual([]);
  });

  it("does not touch another account's persisted recovery audio", async () => {
    const removeEntry = installRecoveryFile();
    savePendingStagingRecovery({
      version: 2,
      recordingId: 'rec_other_account',
      contentType: 'audio/webm',
      durationMs: 30_000,
      endedAt: Date.now() - 120_000,
      createdAt: Date.now() - 120_000,
      ownerSub: 'user_2',
      ownerOrgId: 'org_2',
      ownerSessionKey: 'user_2',
      transcriptionDeferred: true,
      needsFinalize: false,
      action: 'upload',
    });

    renderWeb();
    await act(async () => {});

    expect(mintStagingUrls).not.toHaveBeenCalled();
    expect(completeStaging).not.toHaveBeenCalled();
    expect(abandonStaging).not.toHaveBeenCalled();
    expect(removeEntry).not.toHaveBeenCalled();
    expect(listPendingStagingRecoveries()).toHaveLength(1);
  });

  it('does not recover support audio under an ordinary login for the same user and org', async () => {
    const removeEntry = installRecoveryFile();
    savePendingStagingRecovery({
      version: 2,
      recordingId: 'rec_support_recovery',
      contentType: 'audio/webm',
      durationMs: 30_000,
      endedAt: Date.now() - 120_000,
      createdAt: Date.now() - 120_000,
      ownerSub: 'user_1',
      ownerOrgId: 'org_1',
      ownerSessionKey: 'support_session_1',
      transcriptionDeferred: true,
      needsFinalize: false,
      action: 'upload',
    });
    const session = mutableAuth({
      state: 'signed-in',
      accounts: [
        {
          sub: 'user_1',
          sessionKey: 'user_1',
          email: 'target@example.com',
          activeOrgId: 'org_1',
        },
      ],
      activeSub: 'user_1',
      activeSessionKey: 'user_1',
    });

    renderWithPorts({ uploadTranscriptionChunk: upload }, undefined, session.auth);
    await act(async () => {});

    expect(mintStagingUrls).not.toHaveBeenCalled();
    expect(finalizeRecording).not.toHaveBeenCalled();
    expect(completeStaging).not.toHaveBeenCalled();
    expect(abandonStaging).not.toHaveBeenCalled();
    expect(removeEntry).not.toHaveBeenCalled();
    expect(listPendingStagingRecoveries()).toHaveLength(1);
  });

  it('aborts an active support recording instead of continuing under the ordinary same-user login', async () => {
    const supportView = {
      state: 'signed-in' as const,
      accounts: [
        {
          sub: 'user_1',
          sessionKey: 'support_session_1',
          email: 'target@example.com',
          activeOrgId: 'org_1',
        },
      ],
      activeSub: 'user_1',
      activeSessionKey: 'support_session_1',
    };
    const session = mutableAuth(supportView);
    const { result } = renderWithPorts(
      { uploadTranscriptionChunk: upload },
      undefined,
      session.auth
    );
    await act(async () => {
      await result.current.start('note_1', 'Support investigation');
    });
    pushFrame(16000);
    await act(async () => {});
    const uploadsBeforeStop = upload.mock.calls.length;

    session.setView({
      state: 'signed-in',
      accounts: [
        {
          sub: 'user_1',
          sessionKey: 'user_1',
          email: 'target@example.com',
          activeOrgId: 'org_1',
        },
      ],
      activeSub: 'user_1',
      activeSessionKey: 'user_1',
    });
    pushFrame(16000);
    await act(async () => {});

    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBe('recording.errors.endedUnexpectedly');
    expect(upload).toHaveBeenCalledTimes(uploadsBeforeStop);
    expect(finalizeRecording).not.toHaveBeenCalled();
    expect(FakeAudioContext.last?.close).toHaveBeenCalled();
  });

  it('keeps recording alive and every upload pinned to its owner org after an org switch', async () => {
    const session = mutableAuth({
      state: 'signed-in',
      accounts: [
        {
          sub: 'user_1',
          sessionKey: 'support_session_1',
          email: 'target@example.com',
          activeOrgId: 'org_1',
        },
      ],
      activeSub: 'user_1',
      activeSessionKey: 'support_session_1',
    });
    const { result } = renderWithPorts(
      { uploadTranscriptionChunk: upload },
      undefined,
      session.auth
    );
    await act(async () => {
      await result.current.start('note_1', 'Pinned organization');
    });

    session.setView({
      state: 'signed-in',
      accounts: [
        {
          sub: 'user_1',
          sessionKey: 'support_session_1',
          email: 'target@example.com',
          activeOrgId: 'org_2',
        },
      ],
      activeSub: 'user_1',
      activeSessionKey: 'support_session_1',
    });
    pushFrame(16000);
    await act(async () => {});

    expect(result.current.state).toBe('recording');
    expect(upload).toHaveBeenCalledWith(
      'rec_web',
      expect.any(ArrayBuffer),
      expect.objectContaining({
        authToken: 'support-token',
        activeOrgId: 'org_1',
      })
    );
  });

  it('rejects an ordinary bearer swap before the reactive support view publishes', async () => {
    const supportView = {
      state: 'signed-in' as const,
      accounts: [
        {
          sub: 'user_1',
          sessionKey: 'support_session_1',
          email: 'target@example.com',
          activeOrgId: 'org_1',
        },
      ],
      activeSub: 'user_1',
      activeSessionKey: 'support_session_1',
    };
    const session = mutableAuth(supportView);
    const { result } = renderWithPorts(
      { uploadTranscriptionChunk: upload },
      undefined,
      session.auth
    );
    await act(async () => {
      await result.current.start('note_1', 'Atomic support boundary');
    });

    // AuthProvider's authoritative store has already selected the ordinary
    // slot, while AuthPort.getSession still exposes the old support view.
    session.setCredentialContext('user_1', 'org_1', 'ordinary-token');
    pushFrame(16000);
    await act(async () => {});

    expect(result.current.state).toBe('recording');
    expect(upload).not.toHaveBeenCalled();
  });

  it('cleans retained audio when the original recording was deleted', async () => {
    const removeEntry = installRecoveryFile();
    savePendingStagingRecovery({
      version: 2,
      recordingId: 'rec_deleted',
      contentType: 'audio/webm',
      durationMs: 30_000,
      endedAt: Date.now() - 120_000,
      createdAt: Date.now() - 120_000,
      ownerSub: 'user_1',
      ownerOrgId: 'org_1',
      ownerSessionKey: 'user_1',
      transcriptionDeferred: true,
      needsFinalize: false,
      action: 'abandon',
      abandonReason: 'upload-failed',
    });
    vi.mocked(abandonStaging).mockRejectedValueOnce(
      new ApiError('NOT_FOUND', 'Recording not found', 404)
    );

    renderWeb();

    await waitFor(() => expect(listPendingStagingRecoveries()).toEqual([]));
    expect(abandonStaging).toHaveBeenCalledWith('rec_deleted', 'upload-failed', 'org_1', 'tok');
    expect(removeEntry).toHaveBeenCalledWith('staging-rec_deleted');
  });

  it('flushes the partial chunk at pause, suspends, and resume continues the counter + timeline', async () => {
    const { result } = renderWeb();
    expect(result.current.canPause).toBe(true);

    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    expect(result.current.state).toBe('recording');

    // 1s of silence = exactly the first warm-up chunk → chunk 0 cuts at 0ms.
    pushFrame(16000);
    // 0.5s more sits buffered (below the 2s warm-up minimum for chunk 1).
    pushFrame(8000);

    await act(async () => {
      await result.current.pause();
    });
    expect(result.current.state).toBe('paused');
    expect(result.current.isPaused).toBe(true);
    // The buffered 0.5s flushed as chunk 1 — transcript complete at the pause point —
    // and the context suspended after the flush.
    expect(FakeWorkletNode.last?.port.posted).toContainEqual({ type: 'flush' });
    expect(FakeAudioContext.last?.suspend).toHaveBeenCalled();
    expect(upload.mock.calls.map(c => c[2])).toEqual([
      { chunkIndex: 0, chunkStartMs: 0, authToken: 'tok', activeOrgId: 'org_1' },
      { chunkIndex: 1, chunkStartMs: 1000, authToken: 'tok', activeOrgId: 'org_1' },
    ]);

    await act(async () => {
      await result.current.resume();
    });
    expect(result.current.state).toBe('recording');
    expect(FakeAudioContext.last?.resume).toHaveBeenCalled();

    // 3s of silence = the next (steady-min) chunk: the index continues at 2 and the
    // media timeline continues at 1500ms — the paused gap is compressed out.
    pushFrame(48000);
    await act(async () => {}); // let the upload lane's microtask run
    expect(upload.mock.calls.map(c => c[2])).toContainEqual({
      chunkIndex: 2,
      chunkStartMs: 1500,
      authToken: 'tok',
      activeOrgId: 'org_1',
    });
  });

  it('a user-fixable chunk failure shows the server copy and halts the rest of the uploads', async () => {
    const user = {
      title: 'Your Deepgram key was rejected.',
      body: 'Update it in Settings, or use Prismical Cloud for now.',
      severity: 'warning',
      actions: [{ kind: 'open-ai-models', label: 'Open AI models' }],
    };
    upload.mockRejectedValueOnce(
      new ApiError('PROVIDER_KEY_INVALID', 'rejected', 422, {
        lane: 'your-key',
        provider: 'deepgram',
        user,
      })
    );
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });

    pushFrame(16000); // chunk 0 → 422
    await act(async () => {});
    await waitFor(() =>
      expect(result.current.error).toBe('recording.errors.someAudioNotTranscribed')
    );
    expect(result.current.errorUser).toEqual(user);
    // Every later chunk would fail the same way: nothing more goes on the wire, the session
    // itself keeps recording.
    pushFrame(48000);
    await act(async () => {});
    expect(upload).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('recording');

    // Dismissing (or any other error) drops the server block with the key it belonged to.
    act(() => result.current.clearError());
    expect(result.current.errorUser).toBeNull();
  });

  it('an outage keeps retrying and keeps the generic line (no server copy)', async () => {
    upload.mockRejectedValue(new ApiError('PROVIDER_UNAVAILABLE', 'down', 502));
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    pushFrame(16000);
    await waitFor(
      () => expect(result.current.error).toBe('recording.errors.someAudioNotTranscribed'),
      {
        timeout: 5000,
      }
    );
    expect(result.current.errorUser).toBeNull();
    // A 5xx never halts the session: the next chunk is still attempted.
    pushFrame(48000);
    await act(async () => {});
    expect(upload.mock.calls.length).toBeGreaterThan(3);
  });

  it("resume during pause's flush beat wins — the context is never left suspended", async () => {
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    pushFrame(16000);

    // A plain double-click: Pause, then Play ~30ms later — inside pause's 150ms flush
    // beat. The voided pause must NOT suspend the context the UI says is live again.
    let pausePromise: Promise<boolean> | undefined;
    act(() => {
      pausePromise = result.current.pause();
    });
    expect(result.current.state).toBe('paused');
    await act(async () => {
      await new Promise(r => setTimeout(r, 30));
      await result.current.resume();
    });
    expect(result.current.state).toBe('recording');
    await act(async () => {
      await pausePromise;
    });
    expect(result.current.state).toBe('recording');
    expect(FakeAudioContext.last?.suspend).not.toHaveBeenCalled();
  });

  it('flags a dead mic after sustained exact-zero audio, but never for quiet real audio', async () => {
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    expect(result.current.micSilent).toBe(false);

    // 3s of pure zeros — under the 4s threshold, no flag yet.
    pushFrame(48000);
    expect(result.current.micSilent).toBe(false);

    // A quiet-but-real frame (noise floor ~1e-3) resets the run: never flag a working mic.
    act(() => {
      const noise = new Float32Array(16000).fill(0.001);
      FakeWorkletNode.last?.port.onmessage?.({
        data: { type: 'audioFrame', frame: noise },
      } as MessageEvent);
    });
    pushFrame(48000); // 3s of zeros again after the reset — still under threshold
    expect(result.current.micSilent).toBe(false);

    pushFrame(16000); // 4th consecutive silent second — dead stream
    expect(result.current.micSilent).toBe(true);
    // Toast-only surface: micSilent must NOT set the dock's error pill.
    expect(result.current.error).toBeNull();

    // A fresh start re-arms the detector and clears the flag. (Separate acts: start must
    // read the post-stop "idle" state, not the closure captured before stop.)
    await act(async () => {
      await result.current.stop();
    });
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    expect(result.current.micSilent).toBe(false);
  });

  it('falls back to live chunks when deferred mode cannot create a session buffer', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    vi.mocked(getTranscriptionSettings).mockResolvedValueOnce({ liveTranscription: false });
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });

    pushFrame(16000);
    await act(async () => {});
    expect(upload).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.stop();
    });
    expect(finalizeRecording).toHaveBeenCalledWith(
      'rec_web',
      1000,
      false,
      false,
      expect.objectContaining({ activeOrgId: 'org_1', endedAt: expect.any(Number) })
    );
  });

  it('marks finalization deferred only after durable OPFS and recovery-ledger setup', async () => {
    installDurableStagingFile();
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.mocked(getTranscriptionSettings).mockResolvedValueOnce({ liveTranscription: false });
    vi.mocked(mintStagingUrls).mockResolvedValueOnce({
      uploads: [
        {
          lane: 'mic',
          objectName: 'recordings/rec_web/mic.webm',
          url: 'https://upload.test',
          headers: { 'Content-Type': 'audio/webm' },
        },
      ],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async input =>
        input === '/audio-recorder-processor.js'
          ? ({} as Response)
          : ({ ok: true, status: 200 } as Response)
      )
    );
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    pushFrame(16000);

    await act(async () => {
      await result.current.stop();
    });

    expect(upload).not.toHaveBeenCalled();
    expect(finalizeRecording).toHaveBeenCalledWith(
      'rec_web',
      1000,
      true,
      true,
      expect.objectContaining({ activeOrgId: 'org_1', endedAt: expect.any(Number) })
    );
    await waitFor(() => expect(completeStaging).toHaveBeenCalledTimes(1));
    expect(listPendingStagingRecoveries()).toEqual([]);
  });

  it('keeps live staging pinned to the recording owner org', async () => {
    installDurableStagingFile();
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.mocked(mintStagingUrls).mockResolvedValueOnce({
      uploads: [
        {
          lane: 'mic',
          objectName: 'recordings/rec_web/mic.webm',
          url: 'https://upload.test',
          headers: { 'Content-Type': 'audio/webm' },
        },
      ],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async input =>
        input === '/audio-recorder-processor.js'
          ? ({} as Response)
          : ({ ok: true, status: 200 } as Response)
      )
    );
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    pushFrame(16000);

    await act(async () => {
      await result.current.stop();
    });

    await waitFor(() =>
      expect(mintStagingUrls).toHaveBeenCalledWith(
        'rec_web',
        [{ lane: 'mic', contentType: 'audio/webm' }],
        'org_1',
        'tok'
      )
    );
    expect(finalizeRecording).toHaveBeenCalledWith(
      'rec_web',
      1000,
      true,
      false,
      expect.objectContaining({ activeOrgId: 'org_1', endedAt: expect.any(Number) })
    );
  });

  it('stop from paused finalizes with the sample-based duration', async () => {
    const { result } = renderWeb();
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    pushFrame(16000); // chunk 0
    await act(async () => {
      await result.current.pause();
    });
    let stopped: { segments: number } | undefined;
    await act(async () => {
      stopped = await result.current.stop();
    });
    expect(result.current.state).toBe('idle');
    expect(stopped).toEqual({ segments: 0 });
    // durationMs = sent samples (1s), NOT wall clock — paused time never counts.
    expect(finalizeRecording).toHaveBeenCalledWith(
      'rec_web',
      1000,
      false,
      false,
      expect.objectContaining({ activeOrgId: 'org_1', endedAt: expect.any(Number) })
    );
    expect(FakeAudioContext.last?.close).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auto-pause on silence
// ---------------------------------------------------------------------------
// The DECISION is unit-tested in @prismical/silence; this suite pins down the WIRING — that
// frames reach the detector, that the prompt appears and the pause actually commits, that a
// transcribed chunk cancels it, and above all that none of it happens when the org flag is off.
describe('useRecording — auto-pause on silence', () => {
  let upload: ReturnType<typeof vi.fn>;
  let originalMediaDevices: PropertyDescriptor | undefined;
  let originalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({}))
    );
    originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
      configurable: true,
    });
    upload = vi.fn(async () => []);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    } else {
      delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
    if (originalStorage) {
      Object.defineProperty(navigator, 'storage', originalStorage);
    } else {
      delete (navigator as { storage?: unknown }).storage;
    }
  });

  /** Thresholds are deliberately just past the 30s minimum-session floor the hook enforces. */
  type Policy = {
    silenceSeconds: number;
    graceSeconds: number;
    autoStopAfterPausedMinutes?: number;
  };
  const POLICY: Policy = { silenceSeconds: 40, graceSeconds: 10 };
  const SECOND = 16000;

  const renderAuto = (policy: Policy = POLICY) =>
    renderWithPorts({ uploadTranscriptionChunk: upload }, policy);

  const startAndFeedSilence = async (
    result: { current: ReturnType<typeof useRecording> },
    seconds: number
  ) => {
    await act(async () => {
      await result.current.start('note_1', 'Standup');
    });
    // One second per frame keeps the chunker cutting on its normal cadence, so this exercises the
    // real upload path rather than a synthetic single giant frame.
    for (let i = 0; i < seconds; i++) pushFrame(SECOND);
  };

  it('does nothing at all when the org flag is off', async () => {
    const { result } = renderWithPorts({ uploadTranscriptionChunk: upload }); // no policy seeded
    await startAndFeedSilence(result, 120);
    expect(result.current.gracePrompt).toBeNull();
    expect(result.current.state).toBe('recording');
  });

  it('raises the prompt after the silence threshold, then commits the pause when it lapses', async () => {
    const { result } = renderAuto();
    await startAndFeedSilence(result, 39);
    expect(result.current.gracePrompt).toBeNull();

    pushFrame(SECOND * 2); // crosses 40s
    expect(result.current.gracePrompt).not.toBeNull();
    expect(result.current.gracePrompt?.graceMs).toBe(10_000);
    expect(result.current.state).toBe('recording'); // still capturing during the grace window

    await act(async () => {
      pushFrame(SECOND * 10); // the countdown lapses untouched
      // The commit is fire-and-forget from the frame handler, and pause() gives the worklet a
      // 150ms flush beat before suspending — wait it out rather than asserting mid-choreography.
      await new Promise(r => setTimeout(r, 250));
    });
    expect(result.current.state).toBe('paused');
    expect(result.current.pauseReason).toBe('silence');
    expect(result.current.gracePrompt).toBeNull();
    expect(FakeAudioContext.last?.suspend).toHaveBeenCalled();
  });

  it('never fires inside the opening 30 seconds, whatever the configured threshold', async () => {
    const { result } = renderAuto({ silenceSeconds: 5, graceSeconds: 5 });
    await startAndFeedSilence(result, 20);
    expect(result.current.gracePrompt).toBeNull();
    expect(result.current.state).toBe('recording');
  });

  it('withdraws the prompt when the ASR returns text (the two-signal rule)', async () => {
    // Silence by level, but the transcriber heard words — a quiet speaker must never be paused.
    upload = vi.fn(async () => [
      {
        id: 'seg_1',
        recordingId: 'rec_web',
        source: 'mic',
        speaker: 'You',
        text: 'still here',
        startTimeMs: 0,
        endTimeMs: 500,
        segmentOrder: 1_000_000,
      },
    ]);
    const { result } = renderAuto();
    await startAndFeedSilence(result, 41);
    await act(async () => {}); // let the upload lane resolve
    expect(result.current.gracePrompt).toBeNull();
    expect(result.current.state).toBe('recording');
  });

  it('keeps recording — and stays suppressed for the rest of the session', async () => {
    const { result } = renderAuto();
    await startAndFeedSilence(result, 41);
    expect(result.current.gracePrompt).not.toBeNull();

    act(() => result.current.keepRecording());
    expect(result.current.gracePrompt).toBeNull();
    expect(result.current.state).toBe('recording');

    // Another two minutes of dead silence must NOT ask again.
    await act(async () => {
      for (let i = 0; i < 120; i++) pushFrame(SECOND);
    });
    expect(result.current.gracePrompt).toBeNull();
    expect(result.current.state).toBe('recording');
  });

  it('pauses immediately from the prompt, attributed to the user', async () => {
    const { result } = renderAuto();
    await startAndFeedSilence(result, 41);
    await act(async () => {
      result.current.pauseFromPrompt();
    });
    expect(result.current.state).toBe('paused');
    expect(result.current.pauseReason).toBe('user');
    expect(result.current.gracePrompt).toBeNull();
  });

  it('clears the prompt and the reason when the session stops', async () => {
    const { result } = renderAuto();
    await startAndFeedSilence(result, 41);
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.gracePrompt).toBeNull();
    expect(result.current.pauseReason).toBeNull();
    expect(result.current.state).toBe('idle');
  });

  it('starts a fresh session clean — no suppression or silence carried over', async () => {
    const { result } = renderAuto();
    await startAndFeedSilence(result, 41);
    act(() => result.current.keepRecording()); // suppressed for THAT session
    await act(async () => {
      await result.current.stop();
    });

    await startAndFeedSilence(result, 41);
    expect(result.current.gracePrompt).not.toBeNull();
  });

  it('REQUESTS an auto-stop once the paused window lapses, rather than stopping itself', async () => {
    // The hook detects the deadline; the CALLER performs the stop through its own handler. Calling
    // stop() here would finalize the recording but skip everything the dock owns around a stop —
    // completed analytics, the cache invalidations, auto-enhance — so an auto-stopped session
    // would leave a transcript that never becomes a note.
    vi.useFakeTimers();
    try {
      const { result } = renderAuto({ ...POLICY, autoStopAfterPausedMinutes: 1 });
      await act(async () => {
        await result.current.start('note_1', 'Standup');
      });
      pushFrame(SECOND);
      await act(async () => {
        const paused = result.current.pause();
        await vi.advanceTimersByTimeAsync(300);
        await paused;
      });
      expect(result.current.state).toBe('paused');
      expect(result.current.autoStopRequested).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(result.current.autoStopRequested).toBe(true);
      // Still paused: nothing was finalized behind the caller's back.
      expect(result.current.state).toBe('paused');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not arm auto-pause in deferred mode, where the ASR signal does not exist', async () => {
    // Deferred uploads no chunks, so noteTranscribedSpeech() is never called and the two-signal
    // rule collapses to the bare energy gate — and it meters nothing, so there is no quota being
    // burned to justify running on one signal.
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: vi.fn(async () => ({
          getFileHandle: vi.fn(async () => ({
            createWritable: vi.fn(async () => ({
              write: vi.fn(async () => {}),
              close: vi.fn(async () => {}),
            })),
            getFile: vi.fn(async () => new File(['audio'], 'staging-rec_web')),
          })),
          removeEntry: vi.fn(async () => {}),
        })),
      },
    });
    vi.mocked(getTranscriptionSettings).mockResolvedValueOnce({ liveTranscription: false });
    const { result } = renderAuto();
    await startAndFeedSilence(result, 120);
    expect(result.current.gracePrompt).toBeNull();
    expect(result.current.state).toBe('recording');
  });
});
