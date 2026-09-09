// app-client runtime configuration.
//
// The env seam for the NON-React data code — `apiClient` (client.ts) and the
// Ask transport (ask/transport.ts) run inside React Query fns / transport
// factories, not React, so they cannot read the EnvPort from context. The shell
// injects its EnvPort here ONCE at bootstrap (web: from the root layout's ports
// provider module; desktop: from main's env descriptor), and this module
// hands the resolved descriptor to that non-React code. React code reads env
// through the ports context (`useEnv()`), which is wired to the same port.
//
// No fallback and no browser-host sniffing: a consumer that runs
// before `configureAppClient` throws loudly rather than silently guessing a URL.

import type {
  EnvDescriptor,
  EnvPort,
  NoteLogConfig,
  TransportPort,
} from "@prismical/app-contracts";
import { configureClientDiagnostics, type ClientDiagnostics } from "./diagnostics";
import type { ObservablePersistPlugin } from "@legendapp/state/sync";
import type { SyncPartition } from "./sync/partition";

/**
 * Factory for a partition-scoped sync persistence plugin. Desktop
 * injects `createIndexedDbPersistPlugin` so each (account, org) partition
 * persists to its own IndexedDB database; web leaves it unset — the sync
 * store runs in-memory there (every boot is a full pull, ≈ today's behavior).
 */
export type SyncPersistenceFactory = (
  partition: SyncPartition,
) => Promise<ObservablePersistPlugin>;

/**
 * A fetch-shaped function the Ask streaming lane can use INSTEAD of a direct
 * `fetch(coreApiBaseUrl())`. The web shell injects nothing (the AI-SDK transport
 * fetches the server directly); the desktop mount injects a shim over the
 * MessagePort stream lane so the renderer never reaches the server.
 */
export type AskFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

let envPort: EnvPort | null = null;
// The unary-REST transport seam. Web leaves this null and keeps its
// `fetch(coreApiBaseUrl())` lane byte-identical; desktop injects the IPC
// TransportPort so apiClient routes REST through main instead of hitting the server.
let transportPort: TransportPort | null = null;
let askFetch: AskFetch | null = null;
let syncPersistence: SyncPersistenceFactory | null = null;
// The note-body log lane. Web leaves this null and keeps
// its provider-only collab path byte-identical; desktop injects the
// MessagePort log opener so useNoteCollab hydrates/persists through main.
let noteLog: NoteLogConfig | null = null;

/**
 * Inject the renderer's ports into the non-React data lane. Call once, before
 * any request is issued. `transport`/`askFetch`/`syncPersistence`/`noteLog`
 * are optional and only supplied by the desktop mount; when
 * absent, apiClient + the Ask transport keep their web-native fetch behavior
 * unchanged, the sync store runs without persistence, and note collab stays
 * provider-only.
 */
export function configureAppClient(config: {
  env: EnvPort;
  diagnostics?: ClientDiagnostics;
  transport?: TransportPort;
  askFetch?: AskFetch;
  syncPersistence?: SyncPersistenceFactory;
  noteLog?: NoteLogConfig;
}): void {
  envPort = config.env;
  configureClientDiagnostics(config.diagnostics);
  transportPort = config.transport ?? null;
  askFetch = config.askFetch ?? null;
  syncPersistence = config.syncPersistence ?? null;
  noteLog = config.noteLog ?? null;
}

/** The injected sync persistence factory, or null (in-memory sync store). */
export function getSyncPersistenceFactory(): SyncPersistenceFactory | null {
  return syncPersistence;
}

/** The injected note-body log config, or null on web (provider-only collab). */
export function getNoteLogConfig(): NoteLogConfig | null {
  return noteLog;
}

/**
 * The injected unary transport, or null on web (fetch lane). apiClient checks
 * this per request: when present, REST rides the TransportPort IPC lane instead
 * of a direct `fetch` — the desktop transport boundary.
 */
export function getClientTransport(): TransportPort | null {
  return transportPort;
}

/** The injected Ask streaming fetch shim, or null on web (direct fetch). */
export function getAskFetch(): AskFetch | null {
  return askFetch;
}

/** The injected environment descriptor. Throws if the shell never configured us. */
export function getClientEnv(): EnvDescriptor {
  if (!envPort) {
    throw new Error(
      "@prismical/app-client is not configured — call configureAppClient({ env }) during shell bootstrap.",
    );
  }
  return envPort.getEnv();
}

/**
 * The server API base URL for the fetch-based data lane. Present on web (and
 * desktop main's own config); absent in the desktop renderer, which reaches
 * the server over the TransportPort IPC lane by construction — hitting this
 * there is a bug, so it throws rather than minting a relative URL.
 */
export function coreApiBaseUrl(): string {
  const url = getClientEnv().coreApiUrl;
  if (url === undefined) {
    throw new Error(
      "@prismical/app-client: env has no coreApiUrl — the fetch data lane is web-only; desktop routes REST via the TransportPort.",
    );
  }
  return url;
}
