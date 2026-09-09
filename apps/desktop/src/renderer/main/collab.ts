/**
 * Renderer side of the note-body log lane.
 *
 * openNoteLog wraps the transferred MessagePort in the app-contracts
 * NoteLogHandle that use-note-collab consumes. The port arrives via the
 * preload's window.postMessage forward (COLLAB_PORT_WINDOW_MESSAGE, matched by
 * openId — the exact discipline of stream.ts), and speaks the collab
 * vocabulary: inbound {type:'update'} blobs feed onUpdate (buffered until the
 * first subscriber), {type:'hydrated'} settles the hydrated promise and
 * {type:'resync'} (a dropped append) fires onResync; outbound
 * update/flush/compact post structured messages. Non-conforming
 * inbound messages are warn-logged and IGNORED (never terminal — unlike the
 * SSE stream lane, this port is a long-lived bidirectional relay).
 */
import type { CollabOpenResponse, MainWindowDesktopApi } from '@prismical/desktop-contracts';
import { COLLAB_PORT_WINDOW_MESSAGE } from '@prismical/desktop-contracts';
import type { NoteLogFlush, NoteLogHandle, NoteLogHydration } from '@prismical/app-contracts';

declare global {
  interface Window {
    desktop: MainWindowDesktopApi;
  }
}

/** Typed failure so a failed open settles the port chain (never hangs). */
export class NoteLogOpenError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? `note log open failed: ${code}`);
    this.name = 'NoteLogOpenError';
  }
}

export function openNoteLog(noteId: string): NoteLogHandle {
  const handle = window.desktop.collab.open(noteId);

  let portResolve!: (port: MessagePort) => void;
  let portReject!: (error: Error) => void;
  const portPromise = new Promise<MessagePort>((resolve, reject) => {
    portResolve = resolve;
    portReject = reject;
  });
  // A rejected portPromise must never surface as an unhandled rejection; every
  // consumer chain below opts into handling it explicitly.
  portPromise.catch(() => undefined);

  const onWindowMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      typeof data === 'object' &&
      data !== null &&
      (data as { type?: string }).type === COLLAB_PORT_WINDOW_MESSAGE &&
      (data as { openId?: string }).openId === handle.openId &&
      event.ports.length === 1 &&
      event.ports[0] !== undefined
    ) {
      window.removeEventListener('message', onWindowMessage);
      portResolve(event.ports[0]);
    }
  };
  window.addEventListener('message', onWindowMessage);

  // If the open fails (error envelope or a rejected invoke) NO port will ever
  // arrive: drop the window 'message' listener and reject the port promise so
  // queued sends settle as no-ops instead of hanging forever.
  handle.opened.then(
    (result: CollabOpenResponse) => {
      if ('error' in result) {
        window.removeEventListener('message', onWindowMessage);
        portReject(new NoteLogOpenError(result.error.code, result.error.message));
      }
    },
    (error: unknown) => {
      window.removeEventListener('message', onWindowMessage);
      portReject(error instanceof Error ? error : new NoteLogOpenError('INTERNAL', String(error)));
    }
  );

  let closed = false;
  const barriers = new Map<string, (error?: Error) => void>();
  let updateCallback: ((update: Uint8Array) => void) | null = null;
  let resyncCallback: (() => void) | null = null;
  // Replay blobs can land before the consumer subscribes (the port is live the
  // moment it arrives) — buffer them and drain on the first onUpdate.
  const pendingUpdates: Uint8Array[] = [];
  let hydratedResolve!: (hydration: NoteLogHydration) => void;
  const hydrated = new Promise<NoteLogHydration>(resolve => {
    hydratedResolve = resolve;
  });

  void portPromise
    .then(port => {
      port.onmessage = event => {
        if (closed) return;
        const data: unknown = event.data;
        if (typeof data === 'object' && data !== null) {
          const message = data as {
            type?: unknown;
            data?: unknown;
            seq?: unknown;
            count?: unknown;
            requestId?: unknown;
            ok?: unknown;
          };
          if (
            message.type === 'barrier' &&
            typeof message.requestId === 'string' &&
            typeof message.ok === 'boolean'
          ) {
            barriers.get(message.requestId)?.(
              message.ok ? undefined : new Error('The note changes could not be saved.')
            );
            return;
          }
          if (message.type === 'update' && message.data instanceof Uint8Array) {
            if (updateCallback) updateCallback(message.data);
            else pendingUpdates.push(message.data);
            return;
          }
          if (
            message.type === 'hydrated' &&
            typeof message.seq === 'number' &&
            typeof message.count === 'number'
          ) {
            hydratedResolve({ seq: message.seq, count: message.count });
            return;
          }
          // Resync only ever answers an update WE sent, so a subscriber is
          // always attached by then — no buffering (unlike replayed updates).
          if (message.type === 'resync') {
            resyncCallback?.();
            return;
          }
        }
        console.warn('[note-log] ignoring non-conforming port message');
      };
      port.start();
    })
    .catch(() => undefined);

  // Everything outbound rides ONE promise chain so it drains FIFO, and close()
  // joins that chain BEHIND the queued posts. The `closed` guard is therefore
  // evaluated SYNCHRONOUSLY at call time: deferring it into the chain would
  // drop the final flush use-note-collab posts immediately before close() in
  // the same tick, silently losing the last edit burst from the read model.
  // Every hop is caught, so a failed open (rejected portPromise) never surfaces
  // as an unhandled rejection.
  let outbound: Promise<void> = portPromise.then(
    () => undefined,
    () => undefined
  );
  const enqueue = (run: (port: MessagePort) => void): void => {
    outbound = outbound.then(() => portPromise.then(run)).catch(() => undefined);
  };

  const post = (message: unknown): void => {
    if (closed) return;
    enqueue(port => {
      port.postMessage(message);
    });
  };

  return {
    opened: handle.opened,
    hydrated,
    onUpdate: callback => {
      updateCallback = callback;
      for (const update of pendingUpdates.splice(0)) callback(update);
    },
    onResync: callback => {
      resyncCallback = callback;
    },
    sendUpdate: update => post({ type: 'update', data: update }),
    flush: (content: NoteLogFlush) =>
      post({
        type: 'flush',
        text: content.text,
        markdown: content.markdown,
        firstLine: content.firstLine,
      }),
    waitForPendingChanges: () => {
      if (closed) return Promise.reject(new Error('The note connection closed.'));
      const requestId = crypto.randomUUID();
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          barriers.delete(requestId);
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(
          () => finish(new Error('The note changes have not saved yet.')),
          15_000
        );
        barriers.set(requestId, finish);
        post({ type: 'barrier', requestId });
        void portPromise.catch(error => finish(error));
      });
    },
    compact: (upTo, state) => post({ type: 'compact', upTo, state }),
    close: () => {
      if (closed) return;
      closed = true;
      for (const finish of [...barriers.values()]) finish(new Error('The note connection closed.'));
      window.removeEventListener('message', onWindowMessage);
      // Behind the queued posts: the port stays open until they have drained.
      enqueue(port => {
        port.close();
      });
    },
  };
}
