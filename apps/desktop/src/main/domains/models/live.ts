/**
 * ModelManagerLive — the hardened model
 * downloader + disk↔DB sync, reshaped for Effect (no EventEmitter, no raw
 * timers: one FiberMap per model id, progress into a SubscriptionRef).
 *
 * Download pipeline, per model:
 *   pre-flight (in `download`, before the fork): catalogue lookup → not
 *   installed / not in flight → mkdir modelsDir → free-space check via statfs
 *   (remaining bytes + 10% headroom; typed `insufficient-space` refusal)
 *   fiber: fetch (Node/undici, follows HF's 302 to the CDN; `Range` when a
 *   `.part` exists — a 206 whose start/size/etag agree resumes, anything else
 *   restarts from 0) → stream the body into `<filename>.part` with write
 *   backpressure and a streaming SHA-1 (the resumed prefix is hashed first)
 *   → fsync → SHA-1 must equal the catalogue pin (else the .part is discarded)
 *   → atomic rename onto `<filename>` → `local_model` row upserted → republish.
 *   cancel / scope close interrupts the fiber; a whole-fiber finalizer (it
 *   covers every phase, header await through verify/rename/upsert) removes the
 *   `.part` and ALWAYS clears the published entry — `cancelling` is never
 *   terminal. A network/io failure keeps the `.part` for a resumed retry and
 *   publishes `download.status = 'error'` (a pre-flight mkdir/stat failure
 *   publishes the same error entry before the verb fails). On a resumed retry,
 *   only a DEFINITIVE changed-resource answer (200, 416, or a disagreeing 206)
 *   truncates the kept `.part`; a transient non-2xx (429/403/5xx) keeps it.
 *
 * Reconcile (forked at boot, never blocks it, tolerant of a missing dir):
 * rows whose file is missing or truncated → deleted; catalogue-named files
 * without a row → adopted only after their SHA-1 verifies; `.part` files no
 * catalogue filename claims → deleted. A `<catalogue filename>.part` is KEPT
 * because it is a resumable prefix from an earlier boot, and the next download
 * of that model continues it blind — no resume metadata survives a restart, so
 * the streaming SHA-1 over prefix+tail is the backstop (a changed upstream
 * surfaces as checksum-mismatch → .part discarded → clean retry).
 */
import { createHash, type Hash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { Effect, FiberMap, Layer, Option, Ref, Stream, SubscriptionRef } from 'effect';
import type { ModelDownloadView, ModelsStateView } from '@prismical/desktop-contracts';
import { AppConfig } from '../../infra/config/service';
import { MainLogger } from '../../infra/logging/service';
import { OperationalDb, type LocalModelRow } from '../../infra/operational-db/service';
import { PendingReset } from '../../infra/pending-reset/service';
import { MODEL_CATALOGUE, type ModelCatalogueEntry } from './catalogue';
import { ModelError, ModelManager, type ModelManagerApi } from './service';

/** Headroom over the remaining bytes (temp file + filesystem slack). */
const FREE_SPACE_HEADROOM = 1.1;
/** Progress publishes at most every 1% or 1 MB, whichever comes first. */
const PROGRESS_MIN_BYTES = 1024 * 1024;
const PART_SUFFIX = '.part';

/** Injectable disk edge: tests fake the free-space readout instead of filling a disk. */
export interface ModelDiskProbe {
  /** Bytes available to this process on the volume holding `dir` (which exists). */
  readonly freeBytes: (dir: string) => Promise<number>;
}

/** Test seams only — production builds `ModelManagerLive` with the defaults. */
export interface ModelManagerOptions {
  readonly probe?: ModelDiskProbe;
  /** A catalogue whose URLs point at a local fixture server. */
  readonly catalogue?: ReadonlyArray<ModelCatalogueEntry>;
}

const statfsProbe: ModelDiskProbe = {
  freeBytes: async dir => {
    const stats = await fs.promises.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  },
};

/** What a resumed request must agree with (remembered from the first response). */
interface ResumeMeta {
  readonly totalBytes: number | null;
  readonly etag: string | null;
}

interface ContentRange {
  readonly start: number;
  readonly total: number | null;
}

/** `bytes <start>-<end>/<total|*>` → {start, total}; anything else → null. */
const parseContentRange = (header: string | null): ContentRange | null => {
  const match = header === null ? null : /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (match === null) return null;
  const start = Number(match[1]);
  const total = match[3] === '*' ? null : Number(match[3]);
  return Number.isFinite(start) && (total === null || Number.isFinite(total))
    ? { start, total }
    : null;
};

const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'ENOENT';

const fileSize = (file: string): Promise<number | null> =>
  fs.promises.stat(file).then(
    stats => (stats.isFile() ? stats.size : null),
    error => {
      if (isEnoent(error)) return null;
      throw error;
    }
  );

const unlinkQuiet = (file: string): Promise<void> =>
  fs.promises.unlink(file).catch(error => {
    if (!isEnoent(error)) throw error;
  });

/** Feed a whole file through a running hash (the resumed `.part` prefix). */
const hashFileInto = async (hash: Hash, file: string): Promise<number> => {
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return bytes;
};

const sha1File = async (file: string): Promise<string> => {
  const hash = createHash('sha1');
  await hashFileInto(hash, file);
  return hash.digest('hex');
};

const fsync = async (file: string): Promise<void> => {
  const handle = await fs.promises.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const makeModelManagerLive = (
  options: ModelManagerOptions = {}
): Layer.Layer<ModelManager, never, AppConfig | OperationalDb | MainLogger | PendingReset> =>
  Layer.scoped(
    ModelManager,
    Effect.gen(function* () {
      // Ordering, not data: a pending destructive reset purges
      // modelsDir + the local_model rows at boot, and it must have run before
      // this layer's boot reconcile reads either.
      yield* PendingReset;
      const config = yield* AppConfig;
      const db = yield* OperationalDb;
      const log = (yield* MainLogger).scoped('models');
      const modelsDir = config.modelsDir;
      const probe = options.probe ?? statfsProbe;
      const catalogue = options.catalogue ?? MODEL_CATALOGUE;
      const findEntry = (modelId: string): ModelCatalogueEntry | undefined =>
        catalogue.find(entry => entry.id === modelId);

      const partPath = (entry: ModelCatalogueEntry) =>
        path.join(modelsDir, entry.filename + PART_SUFFIX);
      const finalPath = (entry: ModelCatalogueEntry) => path.join(modelsDir, entry.filename);

      // One download fiber per model id; the map's own scope finalizer interrupts
      // every in-flight download when the boot scope closes (the fiber's
      // interrupt handler removes its `.part`).
      const fibers = yield* FiberMap.make<string>();

      // Boot read of the installed rows: a DbError NEVER blocks boot — log and
      // start empty; the forked reconcile below re-reads. Mirrors SettingsService.
      const bootRows = yield* db.listLocalModels().pipe(
        Effect.catchTag('DbError', error =>
          log
            .warn('local models read failed at boot — starting empty', { op: error.op })
            .pipe(Effect.as<ReadonlyArray<LocalModelRow>>([]))
        )
      );
      const rowsRef = yield* Ref.make<ReadonlyMap<string, LocalModelRow>>(
        new Map(bootRows.map(row => [row.modelId, row]))
      );
      const downloadsRef = yield* Ref.make<ReadonlyMap<string, ModelDownloadView>>(new Map());
      // Resume metadata for a `.part` this process wrote. A catalogue-named
      // `.part` from an earlier boot survives reconcile but has no entry
      // here: its resume is blind — `openTransfer` accepts a 206 at the right
      // offset without remembered size/etag, and the streaming SHA-1 over
      // prefix+tail is the backstop for a changed upstream.
      const resumeRef = yield* Ref.make<ReadonlyMap<string, ResumeMeta>>(new Map());

      const buildView = (
        rows: ReadonlyMap<string, LocalModelRow>,
        downloads: ReadonlyMap<string, ModelDownloadView>
      ): ModelsStateView => ({
        models: catalogue.map(entry => {
          const row = rows.get(entry.id);
          return {
            id: entry.id,
            name: entry.name,
            filename: entry.filename,
            sizeBytes: entry.sizeBytes,
            kind: entry.kind,
            recommended: entry.recommended === true,
            installed: row !== undefined,
            installedAt: row?.downloadedAt ?? null,
            download: downloads.get(entry.id) ?? null,
          };
        }),
        modelsDir,
      });

      const state = yield* SubscriptionRef.make(buildView(yield* Ref.get(rowsRef), new Map()));

      const publish: Effect.Effect<void> = Effect.gen(function* () {
        const rows = yield* Ref.get(rowsRef);
        const downloads = yield* Ref.get(downloadsRef);
        yield* SubscriptionRef.set(state, buildView(rows, downloads));
      });

      const setDownload = (modelId: string, view: ModelDownloadView | null) =>
        Ref.update(downloadsRef, downloads => {
          const next = new Map(downloads);
          if (view === null) next.delete(modelId);
          else next.set(modelId, view);
          return next;
        }).pipe(Effect.zipRight(publish));

      const setRow = (modelId: string, row: LocalModelRow | null) =>
        Ref.update(rowsRef, rows => {
          const next = new Map(rows);
          if (row === null) next.delete(modelId);
          else next.set(modelId, row);
          return next;
        });

      const io = (modelId: string, detail: string) => (cause: unknown) =>
        new ModelError({ reason: 'io', modelId, detail: `${detail}: ${String(cause)}` });
      const network = (modelId: string, detail: string) => (cause: unknown) =>
        new ModelError({ reason: 'network', modelId, detail: `${detail}: ${String(cause)}` });

      // ---- the download fiber ------------------------------------------------

      const fetchFrom = (
        entry: ModelCatalogueEntry,
        from: number,
        signal: AbortSignal
      ): Effect.Effect<Response, ModelError> =>
        Effect.tryPromise({
          try: () =>
            fetch(entry.downloadUrl, {
              // HF `resolve/main` answers 302 → CDN; undici re-follows with the
              // Range header intact, so a resume lands on the same byte offset.
              redirect: 'follow',
              headers: from > 0 ? { Range: `bytes=${from}-` } : {},
              signal,
            }),
          catch: network(entry.id, 'fetch failed'),
        });

      const discardBody = (response: Response): Effect.Effect<void> =>
        Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

      /**
       * What the transfer streams from: the response, the offset to append at,
       * and the total — `exact` when the server declared it (content-length /
       * content-range), else the catalogue's approximate size for progress only.
       */
      interface OpenedTransfer {
        readonly response: Response;
        readonly from: number;
        readonly totalBytes: number;
        readonly exact: boolean;
      }

      /**
       * Open the response the transfer will stream from: a resumed 206 that
       * agrees with the `.part` (start offset + remembered size/etag), else a
       * fresh 200 with the `.part` truncated.
       */
      const openTransfer = (
        entry: ModelCatalogueEntry,
        partSize: number,
        signal: AbortSignal
      ): Effect.Effect<OpenedTransfer, ModelError> =>
        Effect.gen(function* () {
          const part = partPath(entry);
          const declaredLength = (response: Response): number | null => {
            const length = Number(response.headers.get('content-length'));
            return Number.isFinite(length) && length > 0 ? length : null;
          };
          const fresh = (response: Response): Effect.Effect<OpenedTransfer, ModelError> =>
            response.status === 200
              ? Effect.succeed({
                  response,
                  from: 0,
                  totalBytes: declaredLength(response) ?? entry.sizeBytes,
                  exact: declaredLength(response) !== null,
                })
              : discardBody(response).pipe(
                  Effect.zipRight(
                    Effect.fail(
                      new ModelError({
                        reason: 'network',
                        modelId: entry.id,
                        detail: `unexpected status ${response.status}`,
                      })
                    )
                  )
                );

          if (partSize === 0) {
            const response = yield* fetchFrom(entry, 0, signal);
            return yield* fresh(response);
          }

          const response = yield* fetchFrom(entry, partSize, signal);
          const remembered = (yield* Ref.get(resumeRef)).get(entry.id);
          const range = parseContentRange(response.headers.get('content-range'));
          const etag = response.headers.get('etag');
          const agrees =
            response.status === 206 &&
            range !== null &&
            range.start === partSize &&
            (remembered === undefined ||
              ((remembered.totalBytes === null ||
                range.total === null ||
                remembered.totalBytes === range.total) &&
                (remembered.etag === null || etag === null || remembered.etag === etag)));
          if (agrees) {
            const length = declaredLength(response);
            const declared = range.total ?? (length === null ? null : partSize + length);
            yield* log.info('model download resuming', {
              modelId: entry.id,
              from: partSize,
              totalBytes: declared,
            });
            return {
              response,
              from: partSize,
              totalBytes: declared ?? entry.sizeBytes,
              exact: declared !== null,
            };
          }

          // Only a DEFINITIVE changed-resource signal may destroy the kept
          // prefix: a 200 (the server ignored the range — the full body is in
          // hand), a 416 (our offset is beyond the resource), or a 206 whose
          // Content-Range/size/etag disagree (!agrees above). Anything else
          // (429/403/5xx…) is a TRANSIENT transport answer: keep the `.part`,
          // surface the normal network error, and let the retry resume it.
          if (response.status !== 200 && response.status !== 206 && response.status !== 416) {
            yield* discardBody(response);
            return yield* Effect.fail(
              new ModelError({
                reason: 'network',
                modelId: entry.id,
                detail: `unexpected status ${response.status} to ranged resume`,
              })
            );
          }
          yield* log.info('model download restarting from 0', {
            modelId: entry.id,
            status: response.status,
            partSize,
          });
          yield* Effect.tryPromise({
            try: () => fs.promises.truncate(part, 0),
            catch: io(entry.id, 'truncate .part'),
          });
          if (response.status === 200) return yield* fresh(response);
          yield* discardBody(response);
          return yield* fresh(yield* fetchFrom(entry, 0, signal));
        });

      const runDownload = (entry: ModelCatalogueEntry): Effect.Effect<void, ModelError> => {
        // Hoisted so the whole-fiber interrupt finalizer below reaches them from
        // ANY phase — the header await, prefix hashing, the body stream, or the
        // post-transfer verify/rename/upsert.
        const controller = new AbortController();
        let writeStream: fs.WriteStream | null = null;
        return Effect.gen(function* () {
          const part = partPath(entry);
          const target = finalPath(entry);
          const partSize = (yield* Effect.tryPromise({
            try: () => fileSize(part),
            catch: io(entry.id, 'stat .part'),
          })) ?? 0;

          const opened = yield* openTransfer(entry, partSize, controller.signal);
          const { response, from, exact } = opened;
          let totalBytes = opened.totalBytes;
          yield* Ref.update(resumeRef, memory =>
            new Map(memory).set(entry.id, {
              totalBytes: exact ? totalBytes : null,
              etag: response.headers.get('etag'),
            })
          );
          if (response.body === null) {
            return yield* Effect.fail(
              new ModelError({ reason: 'network', modelId: entry.id, detail: 'empty body' })
            );
          }

          const hash = createHash('sha1');
          if (from > 0) {
            yield* Effect.tryPromise({
              try: () => hashFileInto(hash, part),
              catch: io(entry.id, 'hash .part'),
            });
          }

          let received = from;
          let lastPublished = from;
          const progress = (status: ModelDownloadView['status']): ModelDownloadView => ({
            status,
            bytesDownloaded: received,
            totalBytes,
            error: null,
          });
          yield* setDownload(entry.id, progress('downloading'));

          const ws = fs.createWriteStream(part, { flags: from > 0 ? 'a' : 'w' });
          writeStream = ws;
          let writeError: unknown = null;
          ws.on('error', error => {
            writeError = error;
          });
          const body = Stream.fromReadableStream<Uint8Array, ModelError>({
            evaluate: () => response.body as ReadableStream<Uint8Array>,
            onError: network(entry.id, 'body stream'),
          });
          const transfer = Stream.runForEach(body, chunk =>
            Effect.gen(function* () {
              if (writeError !== null) return yield* Effect.fail(io(entry.id, 'write')(writeError));
              hash.update(chunk);
              received += chunk.length;
              // Backpressure: a false `write` means the kernel buffer is full —
              // wait for 'drain' (interrupt-aware via the signal) before reading on.
              if (!ws.write(chunk)) {
                yield* Effect.tryPromise({
                  try: signal => once(ws, 'drain', { signal }).then(() => undefined),
                  catch: io(entry.id, 'drain'),
                });
              }
              if (totalBytes < received) totalBytes = received;
              const stepBytes = received - lastPublished;
              if (
                stepBytes >= PROGRESS_MIN_BYTES ||
                (totalBytes > 0 && stepBytes / totalBytes >= 0.01)
              ) {
                lastPublished = received;
                yield* setDownload(entry.id, progress('downloading'));
              }
            })
          ).pipe(
            Effect.zipRight(
              Effect.tryPromise({
                try: async () => {
                  ws.end();
                  await finished(ws);
                  await fsync(part);
                },
                catch: io(entry.id, 'flush .part'),
              })
            ),
            // A failed transfer keeps the `.part` for a resumed retry: flush what
            // arrived (end, not destroy — destroy would drop buffered writes) so
            // the on-disk prefix is exactly the bytes received.
            Effect.tapError(() =>
              Effect.promise(
                () =>
                  new Promise<void>(resolve => {
                    if (ws.destroyed || ws.closed) return resolve();
                    ws.once('close', () => resolve());
                    ws.end();
                  })
              )
            )
          );
          yield* transfer;

          // A declared length the transfer fell short of is a truncated body
          // (kept on disk for resume); without one, the SHA-1 below is the judge.
          if (exact && received !== totalBytes) {
            return yield* Effect.fail(
              new ModelError({
                reason: 'network',
                modelId: entry.id,
                detail: `truncated transfer: ${received} of ${totalBytes} bytes`,
              })
            );
          }

          yield* setDownload(entry.id, progress('verifying'));
          const actual = hash.digest('hex');
          if (actual !== entry.sha1) {
            // The pinned SHA-1 is the contract with upstream — a mismatch is a
            // swapped/corrupt file, never a retry candidate: discard the bytes.
            yield* Effect.promise(() => unlinkQuiet(part));
            yield* Ref.update(resumeRef, memory => {
              const next = new Map(memory);
              next.delete(entry.id);
              return next;
            });
            return yield* Effect.fail(
              new ModelError({
                reason: 'checksum-mismatch',
                modelId: entry.id,
                detail: `expected ${entry.sha1}, got ${actual}`,
              })
            );
          }

          const sizeBytes = yield* Effect.tryPromise({
            try: async () => {
              await fs.promises.rename(part, target);
              return (await fs.promises.stat(target)).size;
            },
            catch: io(entry.id, 'rename'),
          });
          const now = new Date().toISOString();
          const row = {
            modelId: entry.id,
            filename: entry.filename,
            path: target,
            sizeBytes,
            checksum: actual,
            downloadedAt: now,
            verifiedAt: now,
          };
          yield* db
            .upsertLocalModel(row)
            .pipe(Effect.mapError(error => io(entry.id, 'persist row')(error.cause)));
          yield* setRow(entry.id, { ...row, createdAt: now, updatedAt: now });
          yield* Ref.update(resumeRef, memory => {
            const next = new Map(memory);
            next.delete(entry.id);
            return next;
          });
          yield* setDownload(entry.id, null);
          yield* log.info('model installed', { modelId: entry.id, sizeBytes, path: target });
        }).pipe(
          // Cancel / scope close: the interrupt can land in ANY phase of the
          // fiber — awaiting the 302/CDN response headers, hashing a resumed
          // prefix, the body stream, or the verify/rename/upsert tail — so ONE
          // whole-fiber finalizer covers them all: abort the transfer, close the
          // fd BEFORE unlinking (Windows refuses to unlink an open file), remove
          // the `.part`, forget the resume memory, and ALWAYS clear the
          // published entry — `cancelling` can never be a terminal state.
          Effect.onInterrupt(() =>
            Effect.promise(async () => {
              controller.abort();
              const ws = writeStream;
              if (ws !== null && !ws.closed) {
                await new Promise<void>(resolve => {
                  ws.once('close', () => resolve());
                  ws.destroy();
                });
              }
              await unlinkQuiet(partPath(entry));
            }).pipe(
              Effect.zipRight(
                Ref.update(resumeRef, memory => {
                  const next = new Map(memory);
                  next.delete(entry.id);
                  return next;
                })
              ),
              Effect.zipRight(setDownload(entry.id, null)),
              Effect.zipRight(log.info('model download cancelled', { modelId: entry.id }))
            )
          )
        );
      };

      /**
       * The VAD weights ride along with every Whisper install — when a
       * whisper download lands and the (one) `kind: 'vad'` catalogue entry is
       * not installed, kick its download exactly as the renderer would (same
       * verbs, same observable `state`). Refusals are tolerated (already
       * installed out of band, already in flight) and a VAD download FAILURE
       * only ever surfaces on the VAD row — the whisper install stands.
       */
      const autoDownloadVad = (installedEntry: ModelCatalogueEntry): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (installedEntry.kind !== 'whisper') return;
          const vad = catalogue.find(entry => entry.kind === 'vad');
          if (vad === undefined) return;
          if ((yield* Ref.get(rowsRef)).has(vad.id)) return;
          yield* download(vad.id).pipe(
            Effect.tap(() =>
              log.info('vad model auto-download started', {
                modelId: vad.id,
                after: installedEntry.id,
              })
            ),
            Effect.catchTag('ModelError', error =>
              error.reason === 'already-installed' || error.reason === 'download-in-progress'
                ? Effect.void
                : log.warn('vad model auto-download refused', {
                    modelId: vad.id,
                    reason: error.reason,
                    detail: error.detail,
                  })
            )
          );
        });

      /** The supervised body: every failure lands in `state`, never in the fiber's exit. */
      const supervised = (entry: ModelCatalogueEntry): Effect.Effect<void> =>
        runDownload(entry).pipe(
          Effect.zipRight(autoDownloadVad(entry)),
          Effect.catchAll(error =>
            Effect.gen(function* () {
              const current = (yield* Ref.get(downloadsRef)).get(entry.id);
              yield* log.warn('model download failed', {
                modelId: entry.id,
                reason: error.reason,
                detail: error.detail,
              });
              yield* setDownload(entry.id, {
                status: 'error',
                bytesDownloaded: current?.bytesDownloaded ?? 0,
                totalBytes: current?.totalBytes ?? entry.sizeBytes,
                error:
                  error.reason === 'checksum-mismatch' ||
                  error.reason === 'insufficient-space' ||
                  error.reason === 'io'
                    ? error.reason
                    : 'network',
              });
            })
          ),
          Effect.catchAllDefect(defect =>
            log
              .error('model download defect', { modelId: entry.id, defect: String(defect) })
              .pipe(
                Effect.zipRight(
                  setDownload(entry.id, {
                    status: 'error',
                    bytesDownloaded: 0,
                    totalBytes: entry.sizeBytes,
                    error: 'io',
                  })
                )
              )
          )
        );

      // ---- verbs ------------------------------------------------------------

      const download: ModelManagerApi['download'] = modelId =>
        Effect.gen(function* () {
          const entry = findEntry(modelId);
          if (entry === undefined) {
            return yield* Effect.fail(new ModelError({ reason: 'unknown-model', modelId }));
          }
          if (yield* FiberMap.has(fibers, modelId)) {
            return yield* Effect.fail(new ModelError({ reason: 'download-in-progress', modelId }));
          }
          const row = (yield* Ref.get(rowsRef)).get(modelId);
          if (row !== undefined) {
            const present = yield* Effect.promise(() => fileSize(row.path));
            if (present !== null) {
              return yield* Effect.fail(new ModelError({ reason: 'already-installed', modelId }));
            }
            // The file vanished out of band: forget the row and re-download.
            yield* log.warn('installed model file missing — re-downloading', { modelId });
            yield* db
              .deleteLocalModel(modelId)
              .pipe(Effect.catchTag('DbError', () => Effect.void));
            yield* setRow(modelId, null);
          }
          const partSize = yield* Effect.tryPromise({
            try: async () => {
              await fs.promises.mkdir(modelsDir, { recursive: true });
              return (await fileSize(partPath(entry))) ?? 0;
            },
            catch: io(modelId, 'prepare models dir'),
          }).pipe(
            // A pre-flight io failure must land in `state` like every other
            // outcome: the verb is fire-and-forget for the renderer (the IPC
            // handler logs and resolves), so an unpublished failure would leave
            // the Download button dead with no error row.
            Effect.tapError(() =>
              setDownload(modelId, {
                status: 'error',
                bytesDownloaded: 0,
                totalBytes: entry.sizeBytes,
                error: 'io',
              })
            )
          );
          // Free-space pre-flight: the remaining bytes plus
          // headroom must fit, else refuse typed — and publish the refusal so the
          // renderer (fire-and-forget verb) sees why nothing started.
          const free = yield* Effect.promise(() =>
            probe.freeBytes(modelsDir).then(
              bytes => bytes,
              () => null
            )
          );
          const required = Math.ceil(Math.max(entry.sizeBytes - partSize, 0) * FREE_SPACE_HEADROOM);
          if (free !== null && free < required) {
            yield* log.warn('model download refused: insufficient space', {
              modelId,
              required,
              free,
            });
            yield* setDownload(modelId, {
              status: 'error',
              bytesDownloaded: partSize,
              totalBytes: entry.sizeBytes,
              error: 'insufficient-space',
            });
            return yield* Effect.fail(
              new ModelError({
                reason: 'insufficient-space',
                modelId,
                detail: `${required} bytes required, ${free} free`,
              })
            );
          }
          yield* setDownload(modelId, {
            status: 'downloading',
            bytesDownloaded: partSize,
            totalBytes: entry.sizeBytes,
            error: null,
          });
          yield* FiberMap.run(fibers, modelId, supervised(entry));
          yield* log.info('model download started', { modelId, resumeFrom: partSize });
        });

      const cancel: ModelManagerApi['cancel'] = modelId =>
        Effect.gen(function* () {
          if (yield* FiberMap.has(fibers, modelId)) {
            const current = (yield* Ref.get(downloadsRef)).get(modelId);
            if (current !== undefined) yield* setDownload(modelId, { ...current, status: 'cancelling' });
            // Interrupts AND awaits the fiber: its interrupt finalizer removes
            // the `.part` and clears the entry before this resolves. Belt and
            // braces for the narrow race where the fiber FAILED between the
            // `cancelling` publish and the interrupt landing (the supervised
            // wrapper publishes `error` instead): the user asked to cancel, so
            // clear whatever settled state remains — never leave `cancelling`.
            yield* FiberMap.remove(fibers, modelId);
            const settled = (yield* Ref.get(downloadsRef)).get(modelId);
            if (settled?.status === 'cancelling' || settled?.status === 'error') {
              yield* setDownload(modelId, null);
            }
            return;
          }
          const current = (yield* Ref.get(downloadsRef)).get(modelId);
          if (current?.status === 'error') yield* setDownload(modelId, null);
        });

      const remove: ModelManagerApi['delete'] = modelId =>
        Effect.gen(function* () {
          const entry = findEntry(modelId);
          if (entry === undefined) {
            return yield* Effect.fail(new ModelError({ reason: 'unknown-model', modelId }));
          }
          yield* cancel(modelId);
          const row = (yield* Ref.get(rowsRef)).get(modelId);
          yield* Effect.tryPromise({
            try: () => unlinkQuiet(row?.path ?? finalPath(entry)),
            catch: io(modelId, 'unlink'),
          });
          yield* db.deleteLocalModel(modelId);
          yield* setRow(modelId, null);
          yield* publish;
          yield* log.info('model deleted', { modelId });
        });

      const reconcile: ModelManagerApi['reconcile'] = Effect.gen(function* () {
        const report = { removed: 0, adopted: 0, partsDeleted: 0 };
        const rows = yield* db.listLocalModels();
        // A missing dir is simply "no files" (nothing creates it before the
        // first download); any other readdir failure is logged and treated as none.
        const files = yield* Effect.tryPromise({
          try: () => fs.promises.readdir(modelsDir),
          catch: error => error,
        }).pipe(
          Effect.catchAll(error =>
            isEnoent(error)
              ? Effect.succeed<string[]>([])
              : log
                  .warn('models dir unreadable at reconcile', { error: String(error) })
                  .pipe(Effect.as<string[]>([]))
          )
        );
        // Applied to the cache as a DELTA at the end (never a wholesale replace):
        // a download that lands while a stray file is being hashed here must
        // keep its freshly added row. Each removal remembers the SCANNED row's
        // updatedAt so the apply below can tell a since-reinstalled row apart.
        const removed = new Map<string, string>();
        const adopted = new Map<string, LocalModelRow>();
        const surviving = new Set<string>();
        for (const row of rows) {
          const entry = findEntry(row.modelId);
          const size = yield* Effect.promise(() => fileSize(row.path).catch(() => null));
          if (entry === undefined || size === null || size !== row.sizeBytes) {
            yield* log.warn('local model row dropped at reconcile', {
              modelId: row.modelId,
              reason: entry === undefined ? 'not-in-catalogue' : size === null ? 'missing' : 'size',
            });
            yield* db.deleteLocalModel(row.modelId);
            removed.set(row.modelId, row.updatedAt);
            report.removed += 1;
            continue;
          }
          surviving.add(row.modelId);
        }
        for (const entry of catalogue) {
          if (surviving.has(entry.id) || !files.includes(entry.filename)) continue;
          if (yield* FiberMap.has(fibers, entry.id)) continue;
          const target = finalPath(entry);
          const verified = yield* Effect.promise(() =>
            sha1File(target).then(
              actual => actual === entry.sha1,
              () => false
            )
          );
          if (!verified) {
            yield* log.warn('catalogue file present but unverified — not adopted', {
              modelId: entry.id,
              path: target,
            });
            continue;
          }
          const sizeBytes = yield* Effect.promise(() => fileSize(target));
          const now = new Date().toISOString();
          const row = {
            modelId: entry.id,
            filename: entry.filename,
            path: target,
            sizeBytes: sizeBytes ?? 0,
            checksum: entry.sha1,
            downloadedAt: now,
            verifiedAt: now,
          };
          yield* db.upsertLocalModel(row);
          adopted.set(entry.id, { ...row, createdAt: now, updatedAt: now });
          report.adopted += 1;
          yield* log.info('local model adopted at reconcile', { modelId: entry.id });
        }
        for (const file of files) {
          if (!file.endsWith(PART_SUFFIX)) continue;
          // A `<catalogue filename>.part` is a resumable prefix — kept,
          // whether a live download owns it or an earlier boot left it: the
          // next download continues it blind and the SHA-1 over prefix+tail is
          // the backstop. Only a `.part` no catalogue entry names is deleted.
          if (catalogue.some(entry => entry.filename + PART_SUFFIX === file)) continue;
          yield* Effect.promise(() => unlinkQuiet(path.join(modelsDir, file)).catch(() => undefined));
          report.partsDeleted += 1;
        }
        yield* Ref.update(rowsRef, current => {
          const next = new Map(current);
          for (const [modelId, scannedUpdatedAt] of removed) {
            // Drop only the row the scan actually judged: a download that
            // (re)installed the model while the adopt pass was hashing carries
            // a fresh updatedAt and must survive the delta.
            const cached = next.get(modelId);
            if (cached !== undefined && cached.updatedAt === scannedUpdatedAt) {
              next.delete(modelId);
            }
          }
          for (const [modelId, row] of adopted) next.set(modelId, row);
          return next;
        });
        yield* publish;
        yield* log.info('local models reconciled', report);
        return report;
      });

      const installedPath: ModelManagerApi['installedPath'] = modelId =>
        Effect.gen(function* () {
          const row = (yield* Ref.get(rowsRef)).get(modelId);
          if (row === undefined) return Option.none();
          const present = yield* Effect.promise(() => fileSize(row.path).catch(() => null));
          return present === null ? Option.none() : Option.some(row.path);
        });

      // Boot reconcile: forked so hashing a stray multi-GB file never delays
      // boot; a DbError (or any defect) is logged and the boot rows stand.
      yield* Effect.forkScoped(
        reconcile.pipe(
          Effect.catchTag('DbError', error =>
            log.warn('local model reconcile failed — keeping boot rows', { op: error.op })
          ),
          Effect.catchAllDefect(defect =>
            log.error('local model reconcile defect', { defect: String(defect) })
          )
        )
      );
      yield* log.info('model manager ready', { modelsDir, installed: bootRows.length });

      const api: ModelManagerApi = {
        state,
        list: SubscriptionRef.get(state),
        download,
        cancel,
        delete: remove,
        reconcile,
        installedPath,
      };
      return api;
    })
  );

export const ModelManagerLive = makeModelManagerLive();
