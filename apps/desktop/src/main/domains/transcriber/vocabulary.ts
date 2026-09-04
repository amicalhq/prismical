/**
 * The vocabulary shape used by the pure passes, plus the mode-aware
 * VocabularySource read by the on-device lanes:
 *
 *  - LOCAL mode: personal terms and usage live in the workspace product store.
 *  - CLOUD mode: personal and team terms are fetched once per recording and
 *    frozen; failures fold to an empty list, and usage updates remain
 *    server-owned.
 */
import { asc, eq, isNull, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import type { ReplacementHit, VocabularyTerm } from '@prismical/ai-prompts/transcription';
import type { ScopedLog } from '../../infra/logging/service';
import * as schema from '../../infra/product-db/schema';
import { ProductDbError, type ProductDbService } from '../../infra/product-db/service';
import type { AppMode } from '../app-mode/service';
import type { WorkspaceBackendApi } from '../transport/service';

/** Bound one scope to a stable subset ordered by creation time and id. */
export const VOCABULARY_TERM_LIMIT = 500;

/**
 * Live rows → VocabularyTerm[] (blank words dropped, replacement trimmed → null).
 */
export const loadVocabularyTerms = (
  product: ProductDbService
): Effect.Effect<VocabularyTerm[], ProductDbError> =>
  Effect.tryPromise({
    try: async () => {
      const rows = await product.db
        .select({
          id: schema.vocabulary.id,
          word: schema.vocabulary.word,
          replacementWord: schema.vocabulary.replacementWord,
          isReplacement: schema.vocabulary.isReplacement,
        })
        .from(schema.vocabulary)
        .where(isNull(schema.vocabulary.deletedAt))
        .orderBy(asc(schema.vocabulary.createdAt), asc(schema.vocabulary.id))
        .limit(VOCABULARY_TERM_LIMIT);
      return rows.flatMap((row): VocabularyTerm[] => {
        const word = row.word.trim();
        if (word === '') return [];
        const replacementWord = row.replacementWord?.trim() ?? '';
        return [
          {
            id: row.id,
            scope: 'personal',
            word,
            replacementWord: replacementWord === '' ? null : replacementWord,
            isReplacement: row.isReplacement,
          },
        ];
      });
    },
    catch: cause => new ProductDbError({ op: 'vocabulary-load', cause }),
  });

/**
 * Increment usage for every term that fired. This is best-effort and only
 * happens after a segment is written; a usage tick does not advance updatedAt.
 */
export const bumpVocabularyUsage = (
  product: ProductDbService,
  hits: readonly ReplacementHit[]
): Effect.Effect<void, ProductDbError> =>
  Effect.tryPromise({
    try: async () => {
      for (const hit of hits) {
        if (hit.scope !== 'personal' || hit.count <= 0) continue;
        await product.db
          .update(schema.vocabulary)
          .set({ usageCount: sql`${schema.vocabulary.usageCount} + ${hit.count}` })
          .where(eq(schema.vocabulary.id, hit.id));
      }
    },
    catch: cause => new ProductDbError({ op: 'vocabulary-usage', cause }),
  });

/** The sync GET routes the cloud-mode source reads (the renderer syncs the same lanes). */
export const VOCABULARY_PATH = '/apps/v1/me/vocabulary';
export const TEAM_VOCABULARY_PATH = '/apps/v1/me/team-vocabulary';

/** Cloud-mode answers are frozen per recording; only this many recordings stay cached. */
export const VOCABULARY_CACHE_LIMIT = 8;

/**
 * Merge personal and team scopes with personal winning on a case-insensitive
 * word collision;
 * blank words dropped; replacementWord trimmed → null.
 */
export const mergeVocabularyScopes = (
  personalRows: ReadonlyArray<Omit<VocabularyTerm, 'scope'>>,
  teamRows: ReadonlyArray<Omit<VocabularyTerm, 'scope'>>
): VocabularyTerm[] => {
  const seen = new Set<string>();
  const terms: VocabularyTerm[] = [];
  for (const [scope, rows] of [
    ['personal', personalRows],
    ['team', teamRows],
  ] as const) {
    for (const row of rows) {
      const word = row.word?.trim();
      if (!word) continue;
      const key = word.toLowerCase();
      // Personal is pushed first, so a team row on the same word never wins.
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push({
        id: row.id,
        scope,
        word,
        replacementWord: row.replacementWord?.trim() || null,
        isReplacement: row.isReplacement,
      });
    }
  }
  return terms;
};

/**
 * One sync delta-list answer (`{success, results:[rows]}`) → scoped-less
 * terms, defensively narrowed field by field: the lane must survive any
 * malformed answer as "no vocabulary", never as a defect. Tombstones cannot
 * appear (the GET never asks for them) but are skipped anyway.
 */
const wireRows = (bodyJson: unknown): Omit<VocabularyTerm, 'scope'>[] => {
  const results = (bodyJson as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results
    .flatMap((row): Omit<VocabularyTerm, 'scope'>[] => {
      const candidate = row as {
        id?: unknown;
        word?: unknown;
        replacementWord?: unknown;
        isReplacement?: unknown;
        deletedAt?: unknown;
      } | null;
      if (typeof candidate?.id !== 'string' || typeof candidate.word !== 'string') return [];
      if (candidate.deletedAt !== null && candidate.deletedAt !== undefined) return [];
      return [
        {
          id: candidate.id,
          word: candidate.word,
          replacementWord:
            typeof candidate.replacementWord === 'string' ? candidate.replacementWord : null,
          isReplacement: candidate.isReplacement === true,
        },
      ];
    })
    .slice(0, VOCABULARY_TERM_LIMIT);
};

/**
 * What a lane reads: the effective terms for one recording and the usage bump
 * for the rules that fired. NEVER fails — every miss folds to []/void with a
 * warn, because vocabulary must never park or fail a chunk.
 */
export interface VocabularySource {
  readonly termsFor: (recordingId: string) => Effect.Effect<VocabularyTerm[]>;
  readonly bumpUsage: (
    recordingId: string,
    hits: readonly ReplacementHit[]
  ) => Effect.Effect<void>;
}

export interface VocabularySourceOptions {
  readonly mode: AppMode;
  readonly product: ProductDbService;
  readonly backend: WorkspaceBackendApi;
  readonly log: ScopedLog;
}

/** The workspace's vocabulary source — picked by the boot-resolved AppMode. */
export const makeVocabularySource = ({
  mode,
  product,
  backend,
  log,
}: VocabularySourceOptions): VocabularySource => {
  if (mode === 'local') {
    return {
      termsFor: recordingId =>
        loadVocabularyTerms(product).pipe(
          Effect.catchAll(error =>
            log
              .warn('vocabulary load failed — transcribing without hints', {
                recordingId,
                op: error.op,
                cause: String(error.cause),
              })
              .pipe(Effect.as([] as VocabularyTerm[]))
          )
        ),
      bumpUsage: (recordingId, hits) =>
        bumpVocabularyUsage(product, hits).pipe(
          Effect.catchAll(error =>
            log.warn('vocabulary usage bump failed', {
              recordingId,
              op: error.op,
              cause: String(error.cause),
            })
          )
        ),
    };
  }

  // Cloud mode: fetch once per recording and FREEZE (a failure freezes as []
  // too — vocabulary is not worth a per-chunk retry storm). The chunk
  // pipeline is sequential per recording, so the cache never races.
  const cache = new Map<string, VocabularyTerm[]>();
  const fetchScope = (
    recordingId: string,
    path: string
  ): Effect.Effect<Omit<VocabularyTerm, 'scope'>[]> =>
    backend
      .request({ method: 'GET', path })
      .pipe(
        Effect.flatMap(res =>
          'ok' in res && res.status >= 200 && res.status < 300
            ? Effect.succeed(wireRows(res.bodyJson))
            : log
                .warn('vocabulary fetch from core failed — scope empty', {
                  recordingId,
                  path,
                  ...('ok' in res ? { status: res.status } : { error: res.error.code }),
                })
                .pipe(Effect.as([] as Omit<VocabularyTerm, 'scope'>[]))
        ),
        Effect.catchAllDefect(defect =>
          log
            .warn('vocabulary fetch from core defect — scope empty', {
              recordingId,
              path,
              defect: String(defect),
            })
            .pipe(Effect.as([] as Omit<VocabularyTerm, 'scope'>[]))
        )
      );
  return {
    termsFor: recordingId =>
      Effect.suspend(() => {
        const cached = cache.get(recordingId);
        if (cached !== undefined) return Effect.succeed(cached);
        return Effect.zip(
          fetchScope(recordingId, VOCABULARY_PATH),
          fetchScope(recordingId, TEAM_VOCABULARY_PATH)
        ).pipe(
          Effect.map(([personal, team]) => mergeVocabularyScopes(personal, team)),
          Effect.tap(terms =>
            Effect.sync(() => {
              if (cache.size >= VOCABULARY_CACHE_LIMIT) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) cache.delete(oldest);
              }
              cache.set(recordingId, terms);
            })
          )
        );
      }),
    // Usage accounting is server-owned in cloud mode, so on-device hits are
    // not written to the local cache.
    bumpUsage: () => Effect.void,
  };
};
