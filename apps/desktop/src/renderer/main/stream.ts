/**
 * Renderer side of the streaming lane.
 *
 * portToReadableStream turns the transferred MessagePort into a
 * Response(ReadableStream) — the exact shape the ChatTransport shim hands to
 * useChat (AI-SDK transports consume a fetch-like Response, then
 * parseJsonEventStream over its `text/event-stream` body). Main forwards core's
 * SSE bytes VERBATIM: every Uint8Array port message is enqueued unchanged, so
 * no reframing/translation happens here. The stream reaches a terminal state —
 * so no reader.read() hangs — on ALL of: a non-bytes message (the main-side
 * {type:'done'} marker after the SSE body ends), abort() (renderer-initiated),
 * and the main side closing the port (port 'close' event). Every path routes
 * through the ReadableStream controller; abort never closes the raw port out
 * from under a live reader.
 */
import type { MainWindowDesktopApi, OpenStreamRequest, OpenStreamResponse } from '@prismical/desktop-contracts';
import { STREAM_PORT_WINDOW_MESSAGE } from '@prismical/desktop-contracts';

declare global {
  interface Window {
    desktop: MainWindowDesktopApi;
  }
}

export interface PortStream {
  readonly stream: ReadableStream<Uint8Array>;
  /**
   * Settle the stream terminally (idempotent): tell main to abort, close the
   * ReadableStream controller so any pending OR subsequent reader.read()
   * resolves, then drop the port. Routed through the controller — never closes
   * the raw port out from under a live reader.
   */
  readonly abort: () => void;
}

export function portToReadableStream(port: MessagePort): PortStream {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let settled = false;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    try {
      controller?.close();
    } catch {
      // Controller already closed/errored — the reader is already terminal.
    }
    try {
      port.close();
    } catch {
      // Port already closed/neutered.
    }
  };

  const notifyAbort = (): void => {
    try {
      port.postMessage({ type: 'abort' });
    } catch {
      // Port already closed/neutered — settle below still terminates readers.
    }
    settle();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
      port.onmessage = event => {
        if (settled) return;
        const message: unknown = event.data;
        // Main forwards core's SSE as raw bytes; enqueue them VERBATIM. Any
        // non-bytes message is the terminal {type:'done'} marker (the SSE body
        // ended) — settle the reader instead of enqueuing it.
        if (message instanceof Uint8Array) {
          try {
            ctrl.enqueue(message);
          } catch {
            // Controller already closed/errored — the reader is terminal.
          }
          return;
        }
        settle();
      };
      // Electron 38 (Chromium) fires 'close' when the MAIN side closes the port
      // without a {type:'done'} (interrupt / scope teardown). Close the
      // controller so pending/subsequent reads settle instead of hanging. The
      // DOM lib bundled with our TS may not type onclose yet — assign through a
      // typed view.
      (port as MessagePort & { onclose: (() => void) | null }).onclose = () => {
        settle();
      };
      port.start();
    },
    cancel() {
      // Renderer-initiated cancellation via reader.cancel(): tell main, settle.
      notifyAbort();
    },
  });

  return { stream, abort: notifyAbort };
}

/** Typed failure so a failed open settles response/send/abort (never hangs). */
export class StreamOpenError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? `stream open failed: ${code}`);
    this.name = 'StreamOpenError';
  }
}

export interface AskStreamHandle {
  readonly streamId: string;
  readonly opened: Promise<OpenStreamResponse>;
  /** Response wrapping the port-fed ReadableStream (ChatTransport shim shape). */
  readonly response: Promise<Response>;
  readonly send: (message: unknown) => void;
  readonly abort: () => void;
}

export function openAskStream(request: Omit<OpenStreamRequest, 'streamId'>): AskStreamHandle {
  const handle = window.desktop.transport.openStream(request);

  let portResolve!: (port: MessagePort) => void;
  let portReject!: (error: Error) => void;
  const portPromise = new Promise<MessagePort>((resolve, reject) => {
    portResolve = resolve;
    portReject = reject;
  });
  // A rejected portPromise must never surface as an unhandled rejection; the
  // response/send/abort chains below opt into handling it explicitly.
  portPromise.catch(() => undefined);

  const onWindowMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      typeof data === 'object' &&
      data !== null &&
      (data as { type?: string }).type === STREAM_PORT_WINDOW_MESSAGE &&
      (data as { streamId?: string }).streamId === handle.streamId &&
      event.ports.length === 1 &&
      event.ports[0] !== undefined
    ) {
      window.removeEventListener('message', onWindowMessage);
      portResolve(event.ports[0]);
    }
  };
  window.addEventListener('message', onWindowMessage);

  // If the open fails (error envelope or a rejected invoke) NO port will ever
  // arrive: drop the window 'message' listener and reject the port promise with
  // a typed error so response/send/abort settle instead of hanging forever.
  handle.opened.then(
    result => {
      if ('error' in result) {
        window.removeEventListener('message', onWindowMessage);
        portReject(new StreamOpenError(result.error.code, result.error.message));
      }
    },
    (error: unknown) => {
      window.removeEventListener('message', onWindowMessage);
      portReject(error instanceof Error ? error : new StreamOpenError('INTERNAL', String(error)));
    }
  );

  const portStreamPromise = portPromise.then(port => portToReadableStream(port));
  // text/event-stream so app-client's DefaultChatTransport routes the body
  // through parseJsonEventStream (the SSE parser) — matching what web gets when
  // it fetches core's toUIMessageStreamResponse() directly.
  const response = portStreamPromise.then(
    ({ stream }) => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  );

  return {
    streamId: handle.streamId,
    opened: handle.opened,
    response,
    send: message => {
      void portPromise
        .then(port => {
          port.postMessage(message);
        })
        .catch(() => undefined);
    },
    // Route abort through the ReadableStream (controller close), not by closing
    // the raw port — a pending/subsequent reader.read() must terminate.
    abort: () => {
      void portStreamPromise.then(({ abort }) => abort()).catch(() => undefined);
    },
  };
}
