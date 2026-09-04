/**
 * The test-only window.desktop.e2e surface. Sandboxed
 * preloads can't read process.env, so WindowRegistry forwards config.isE2E as
 * the --prismical-e2e argv switch (webPreferences.additionalArguments); this
 * factory gates the surface on that switch. Pure + electron-free so the
 * absence/presence decision is unit-testable: outside E2E the
 * bridge must carry NO `e2e` key at all — not an empty object, not
 * reject-on-invoke stubs. The main process only registers these channels
 * under PRISMICAL_E2E anyway, but an exposed surface would still be a probing
 * fingerprint; this gate keeps the production bridge exactly the v1 contract.
 */
import {
  CHANNELS,
  type MainWindowDesktopApi,
  type RecordingE2ECommand,
  type SessionProbe,
  type StreamStats,
} from '@prismical/desktop-contracts';

export const E2E_ARGV_SWITCH = '--prismical-e2e';

export type E2ESurface = Pick<MainWindowDesktopApi, 'e2e'>;

export const makeE2ESurface = (
  argv: ReadonlyArray<string>,
  invoke: (channel: string, payload?: unknown) => Promise<unknown>
): E2ESurface =>
  argv.includes(E2E_ARGV_SWITCH)
    ? {
        e2e: {
          streamStats: () => invoke(CHANNELS.e2eStreamStats) as Promise<StreamStats>,
          authPendingState: () =>
            invoke(CHANNELS.e2eAuthPendingState) as Promise<string | null>,
          authAuthorizeUrl: () =>
            invoke(CHANNELS.e2eAuthAuthorizeUrl) as Promise<string | null>,
          sessionProbe: () => invoke(CHANNELS.e2eSessionProbe) as Promise<SessionProbe>,
          recording: (command: RecordingE2ECommand) =>
            invoke(CHANNELS.e2eRecording, command) as Promise<void>,
        },
      }
    : {};
