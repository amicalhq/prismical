import type { MessagePortMain } from 'electron';
import { Context, Data, type Effect } from 'effect';
import type { StreamStats } from '@prismical/desktop-contracts';

export class StreamError extends Data.TaggedError('StreamError')<{
  readonly code: 'DUPLICATE_STREAM';
  readonly streamId: string;
}> {}

/** Minimal sender surface the broker needs (event.sender in production). */
export interface StreamPortSender {
  readonly postMessage: (channel: string, message: unknown, transfer?: MessagePortMain[]) => void;
}

/**
 * Streaming lane: one MessageChannelMain per stream, port2 posted
 * to the renderer, a producer fiber per stream supervised in a FiberMap keyed by
 * stream id. Port close / {type:'abort'} interrupts the fiber; the
 * resume seam ({type:'resume'} inbound) stays wired.
 *
 * The producer opens the REAL Ask stream through the current session's
 * WorkspaceBackend (POST /apps/v1/me/ask, Bearer + org stamped in MAIN) and forwards
 * core's AI-SDK SSE bytes VERBATIM across the port (a `{type:'done'}` marker
 * terminates). The port protocol, FiberMap supervision and cancellation seams
 * are preserved. `body` is the renderer-built Ask request the producer forwards.
 */
export interface StreamBrokerApi {
  readonly open: (args: {
    readonly streamId: string;
    readonly sender: StreamPortSender;
    readonly body?: unknown;
  }) => Effect.Effect<void, StreamError>;
  readonly stats: Effect.Effect<StreamStats>;
}

export class StreamBroker extends Context.Tag('desktop/StreamBroker')<StreamBroker, StreamBrokerApi>() {}
