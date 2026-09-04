/**
 * Preload collab-open helper — the exact discipline of
 * open-stream.ts on the collab lane's own channel + marker.
 *
 * The collab port arrives on a per-UUID one-shot channel, so the listener must
 * be registered BEFORE the invoke (main posts the port during handler
 * execution). But on an error envelope — UNKNOWN_SENDER, INVALID_REQUEST,
 * NO_WORKSPACE, DUPLICATE, INTERNAL — main never posts a port, stranding the
 * per-UUID `once` listener forever. This helper removes that listener when the
 * open resolves to (or rejects with) a failure. Pure + electron-free so it is
 * unit-testable.
 */
import {
  CHANNELS,
  collabPortChannel,
  type CollabOpenRequest,
  type CollabOpenResponse,
  type DesktopCollabHandle,
} from '@prismical/desktop-contracts';

/** The per-open port event (Electron delivers transferred ports on `.ports`). */
export interface CollabPortEvent {
  readonly ports: ReadonlyArray<MessagePort>;
}

export interface OpenCollabIpc {
  readonly once: (channel: string, listener: (event: CollabPortEvent) => void) => void;
  readonly removeListener: (channel: string, listener: (event: CollabPortEvent) => void) => void;
  readonly invoke: (channel: string, payload: CollabOpenRequest) => Promise<CollabOpenResponse>;
}

export interface OpenCollabDeps {
  readonly randomUUID: () => string;
  readonly forwardPort: (openId: string, ports: ReadonlyArray<MessagePort>) => void;
}

const isErrorEnvelope = (response: CollabOpenResponse): boolean =>
  typeof response === 'object' && response !== null && 'error' in response;

export const makeOpenCollab =
  (ipc: OpenCollabIpc, deps: OpenCollabDeps) =>
  (noteId: string): DesktopCollabHandle => {
    const openId = deps.randomUUID();
    const portChannel = collabPortChannel(openId);
    const onPort = (event: CollabPortEvent): void => {
      deps.forwardPort(openId, event.ports);
    };
    ipc.once(portChannel, onPort);

    const opened = ipc.invoke(CHANNELS.collabOpen, { openId, noteId }).then(
      response => {
        // No port will ever arrive on an error envelope — drop the stranded
        // `once` listener (it auto-removes only after firing on success).
        if (isErrorEnvelope(response)) ipc.removeListener(portChannel, onPort);
        return response;
      },
      (error: unknown) => {
        ipc.removeListener(portChannel, onPort);
        throw error;
      }
    );

    return { openId, opened };
  };
