/**
 * NoteBodyStoreLive + CollabBridgeLive — see store.ts for
 * the contract. The store is WORKSPACE-scoped (built over whichever ProductDb
 * the branch mounts) and self-publishes into the boot-scoped CollabBridge for
 * the workspace's lifetime, exactly as the backends do into WorkspaceTransport.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Effect, Layer, Option, SubscriptionRef } from 'effect';
import * as schema from '../../infra/product-db/schema';
import { ProductDb, ProductDbError } from '../../infra/product-db/service';
import { UNTITLED_NOTE } from '../local-backend/notes';
import {
  CollabBridge,
  NoteBodyStore,
  type CollabBridgeApi,
  type NoteBodyStoreApi,
} from './store';

export const NoteBodyStoreLive: Layer.Layer<NoteBodyStore, never, ProductDb | CollabBridge> =
  Layer.scoped(
    NoteBodyStore,
    Effect.gen(function* () {
      const { db, client } = yield* ProductDb;
      const bridge = yield* CollabBridge;

      const tryDb = <T>(op: string, run: () => Promise<T>): Effect.Effect<T, ProductDbError> =>
        Effect.tryPromise({ try: run, catch: cause => new ProductDbError({ op, cause }) });

      const api: NoteBodyStoreApi = {
        listUpdates: noteId =>
          tryDb('note-body-list', () =>
            db
              .select({ seq: schema.noteBodyUpdate.seq, update: schema.noteBodyUpdate.update })
              .from(schema.noteBodyUpdate)
              .where(eq(schema.noteBodyUpdate.noteId, noteId))
              .orderBy(asc(schema.noteBodyUpdate.seq))
          ),

        appendUpdate: (noteId, update) =>
          tryDb('note-body-append', async () => {
            const now = new Date().toISOString();
            // Lazy stub row (cloud store-hook parity): the body log can start
            // before any metadata write reaches the store.
            await db
              .insert(schema.note)
              .values({
                id: noteId,
                title: UNTITLED_NOTE,
                titleSource: 'placeholder',
                createdAt: now,
                updatedAt: now,
                metadataUpdatedAt: now,
              })
              .onConflictDoNothing();
            // Atomic per-note seq allocation: MAX(seq)+1 computed inside the
            // INSERT itself, so two ports appending to one note cannot race.
            const rows = await db
              .insert(schema.noteBodyUpdate)
              .values({
                noteId,
                seq: sql`coalesce((select max(seq) from note_body_update where note_id = ${noteId}), 0) + 1`,
                update: Buffer.from(update),
                createdAt: now,
              })
              .returning({ seq: schema.noteBodyUpdate.seq });
            const seq = rows[0]?.seq;
            if (seq === undefined) throw new Error('append returned no seq');
            return seq;
          }),

        compact: (noteId, upTo, state) =>
          tryDb('note-body-compact', async () => {
            const now = new Date().toISOString();
            // One immediate transaction (operational-migrator idiom): the
            // prefix delete and the merged-state insert land or roll back
            // together.
            client
              .transaction(() => {
                client
                  .prepare('DELETE FROM note_body_update WHERE note_id = ? AND seq <= ?')
                  .run(noteId, upTo);
                client
                  .prepare(
                    'INSERT INTO note_body_update (note_id, seq, "update", created_at) VALUES (?, ?, ?, ?)'
                  )
                  .run(noteId, upTo, Buffer.from(state), now);
              })
              .immediate();
          }),

        applyFlush: (noteId, content) =>
          tryDb('note-body-flush', async () => {
            const rows = await db
              .select()
              .from(schema.note)
              .where(eq(schema.note.id, noteId))
              .limit(1);
            const existing = rows[0];
            // A flush is a projection of the log — it never creates rows (an
            // append always precedes it; a missing row means the workspace
            // swapped under the port, and fabricating one here would be wrong).
            if (existing === undefined) return;
            const set: Partial<typeof schema.note.$inferInsert> = {
              contentText: content.text,
              contentMarkdown: content.markdown,
              firstLine: content.firstLine,
            };
            // Explicit titles are never touched, tombstoned/trashed rows never
            // retitle, and only a derived-title CHANGE bumps the sync cursor.
            const follows =
              (existing.titleSource === 'placeholder' || existing.titleSource === 'first-line') &&
              existing.deletedAt === null &&
              existing.trashedAt === null;
            await db.update(schema.note).set(set).where(eq(schema.note.id, noteId));
            if (follows) {
              const title = content.firstLine || UNTITLED_NOTE;
              const titleSource = content.firstLine ? 'first-line' : 'placeholder';
              if (existing.title !== title || existing.titleSource !== titleSource) {
                // Keep the follow predicate in the write: a Name-note apply
                // landing between the read above and here turns the row 'ai',
                // and this flush must then leave the title alone.
                await db
                  .update(schema.note)
                  .set({
                    title,
                    titleSource,
                    updatedAt: new Date(
                      Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)
                    ).toISOString(),
                  })
                  .where(
                    and(
                      eq(schema.note.id, noteId),
                      inArray(schema.note.titleSource, ['placeholder', 'first-line']),
                      isNull(schema.note.deletedAt),
                      isNull(schema.note.trashedAt)
                    )
                  );
              }
            }
          }),
      };

      yield* bridge.register(api);
      return api;
    })
  );

/**
 * The boot-scoped store accessor (a leaf: just the current-store
 * SubscriptionRef). `register` is a scoped set/clear driven by the workspace
 * scope, with the same compare-and-clear release as WorkspaceTransportLive: a
 * slow old-workspace close whose release runs AFTER a successor registered
 * must not clobber the live store to None.
 */
export const CollabBridgeLive: Layer.Layer<CollabBridge> = Layer.effect(
  CollabBridge,
  Effect.gen(function* () {
    const currentRef = yield* SubscriptionRef.make<Option.Option<NoteBodyStoreApi>>(Option.none());
    const api: CollabBridgeApi = {
      register: store =>
        Effect.acquireRelease(SubscriptionRef.set(currentRef, Option.some(store)), () =>
          SubscriptionRef.update(currentRef, cur =>
            Option.exists(cur, s => s === store) ? Option.none() : cur
          )
        ).pipe(Effect.asVoid),
      current: SubscriptionRef.get(currentRef),
    };
    return api;
  })
);
