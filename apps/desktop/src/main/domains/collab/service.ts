import type { MessagePortMain } from 'electron';
import { Context, Data, type Effect } from 'effect';

export class CollabError extends Data.TaggedError('CollabError')<{
  readonly code: 'DUPLICATE' | 'NO_WORKSPACE';
  readonly openId: string;
}> {}

/** Minimal sender surface the broker needs (event.sender in production). */
export interface CollabPortSender {
  readonly postMessage: (channel: string, message: unknown, transfer?: MessagePortMain[]) => void;
}

/**
 * The note-body log relay: one MessageChannelMain per
 * open, port2 posted to the renderer, a pump fiber per open supervised in a
 * FiberMap keyed by openId. On open the broker replays the persisted log
 * ({type:'update'} per blob, then {type:'hydrated', seq, count}); afterwards
 * every inbound update is appended to the store (awaited sequentially per
 * port — bounded main-thread work) and relayed VERBATIM to the OTHER ports of
 * the same note (never echoed to its sender, never decoded), which is what
 * makes two windows converge with no server. flush/compact dispatch into the
 * store; invalid messages are warn-logged and dropped. Port close (renderer
 * gone) or layer-scope close tears the open down and closes its port.
 *
 * The store is read through the boot-scoped CollabBridge: None at open →
 * typed NO_WORKSPACE (the renderer degrades to its provider-only path); None
 * mid-session (workspace swap) → appends drop with a warn, never a crash.
 */
export interface CollabBrokerApi {
  readonly open: (args: {
    readonly openId: string;
    readonly noteId: string;
    readonly sender: CollabPortSender;
  }) => Effect.Effect<void, CollabError>;
}

export class CollabBroker extends Context.Tag('desktop/CollabBroker')<
  CollabBroker,
  CollabBrokerApi
>() {}
