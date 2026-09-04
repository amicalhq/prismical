/**
 * Preload openStream helper.
 *
 * The stream port arrives on a per-UUID one-shot channel, so the listener must
 * be registered BEFORE the invoke (main posts the port during handler
 * execution). But on an error envelope — PATH_NOT_ALLOWED, INVALID_REQUEST,
 * UNKNOWN_SENDER, DUPLICATE_STREAM, or any real transport failure — main
 * never posts a port, stranding the per-UUID `once` listener forever. This
 * helper removes that listener when the open resolves to (or rejects with) a
 * failure. Pure + electron-free so it is unit-testable.
 */
import {
  CHANNELS,
  streamPortChannel,
  type DesktopStreamHandle,
  type OpenStreamRequest,
  type OpenStreamResponse,
} from '@prismical/desktop-contracts';

/** The per-stream port event (Electron delivers transferred ports on `.ports`). */
export interface StreamPortEvent {
  readonly ports: ReadonlyArray<MessagePort>;
}

export interface OpenStreamIpc {
  readonly once: (channel: string, listener: (event: StreamPortEvent) => void) => void;
  readonly removeListener: (channel: string, listener: (event: StreamPortEvent) => void) => void;
  readonly invoke: (channel: string, payload: OpenStreamRequest) => Promise<OpenStreamResponse>;
}

export interface OpenStreamDeps {
  readonly randomUUID: () => string;
  readonly forwardPort: (streamId: string, ports: ReadonlyArray<MessagePort>) => void;
}

const isErrorEnvelope = (response: OpenStreamResponse): boolean =>
  typeof response === 'object' && response !== null && 'error' in response;

export const makeOpenStream =
  (ipc: OpenStreamIpc, deps: OpenStreamDeps) =>
  (request: Omit<OpenStreamRequest, 'streamId'>): DesktopStreamHandle => {
    const streamId = deps.randomUUID();
    const portChannel = streamPortChannel(streamId);
    const onPort = (event: StreamPortEvent): void => {
      deps.forwardPort(streamId, event.ports);
    };
    ipc.once(portChannel, onPort);

    const payload: OpenStreamRequest = { ...request, streamId };
    const opened = ipc.invoke(CHANNELS.transportOpenStream, payload).then(
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

    return { streamId, opened };
  };
