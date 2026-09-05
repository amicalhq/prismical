/**
 * Full-text search over the product store: SQLite FTS5 over `note_fts`
 * (title + content_text, maintained by triggers). Serves GET /me/search and
 * the Ask `search_notes` tool;
 * an empty query is the browse-recent lane (most recently updated first).
 */
import type Database from 'better-sqlite3';
import { invalidRequest, ok, type RouteResult } from './wire';

export interface SearchScope {
  readonly folderIds?: ReadonlyArray<string>;
  readonly tagIds?: ReadonlyArray<string>;
}

export interface SearchHit {
  readonly noteId: string;
  readonly title: string;
  /** Plain-text projection returned by `/me/search`. */
  readonly contentText: string;
  /** Markdown projection used for Ask snippets when available. */
  readonly contentMarkdown: string | null;
  /** Retrieval score; 0 in browse mode. */
  readonly rank: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Common English stop words are dropped from mixed queries. A query made ONLY
 * of stop words keeps them — searching for "the" should still find something
 * rather than nothing.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for', 'from', 'has', 'have', 'he',
  'her', 'his', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or',
  'our', 'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

/**
 * Turn free text into an FTS5 MATCH expression that cannot fail to parse:
 * every whitespace-separated token becomes a quoted prefix term (`"foo"*`),
 * implicitly AND-ed. Quotes inside a token are dropped (they are the only
 * character that can unbalance a phrase); FTS5 operators lose their meaning
 * inside quotes, so `NOT`, `OR` and `-` are searched for literally. English
 * stop words are dropped, and the index's porter tokenizer (migration 0002)
 * stems the rest.
 *
 * Returns `null` ONLY for a blank query (browse); a query that tokenised to
 * nothing (all quotes) returns `''`, which the caller maps to no results.
 */
export const toMatchExpression = (query: string): string | null => {
  if (query.trim().length === 0) return null;
  const tokens = query
    .split(/\s+/)
    .map(token => token.replace(/"/g, '').trim())
    .filter(token => token.length > 0);
  if (tokens.length === 0) return '';
  const kept = tokens.filter(token => !STOP_WORDS.has(token.toLowerCase()));
  return (kept.length > 0 ? kept : tokens).map(token => `"${token}"*`).join(' ');
};

const SNIPPET_ROW_LIMIT = 100;

/** Title matches outrank body matches. */
const RANK = 'bm25(note_fts, 0.0, 10.0, 1.0)';

const inList = (ids: ReadonlyArray<string>): string => ids.map(() => '?').join(', ');

interface ScopeSql {
  readonly where: string;
  readonly args: string[];
}

const scopeSql = (scope: SearchScope, alias: string): ScopeSql => {
  const clauses: string[] = [];
  const args: string[] = [];
  if (scope.folderIds && scope.folderIds.length > 0) {
    clauses.push(`${alias}.folder_id IN (${inList(scope.folderIds)})`);
    args.push(...scope.folderIds);
  }
  if (scope.tagIds !== undefined) {
    if (scope.tagIds.length === 0) {
      clauses.push('0');
    } else {
      clauses.push(
        `${alias}.id IN (SELECT note_id FROM note_tag WHERE deleted_at IS NULL AND tag_id IN (${inList(scope.tagIds)}))`
      );
      args.push(...scope.tagIds);
    }
  }
  return { where: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', args };
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A raw note row as the search statements project it (column names as-is). */
interface SearchRow {
  readonly id: unknown;
  readonly title: unknown;
  readonly content_text: unknown;
  readonly content_markdown: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly rank?: unknown;
}

export interface SearchArgs {
  readonly query: string;
  readonly limit: number;
  readonly offset?: number;
  readonly scope?: SearchScope;
}

/** Ranked hits (query) or the most recently updated notes (empty query). */
export async function searchNotes(
  client: Database.Database,
  args: SearchArgs
): Promise<{ hits: SearchHit[]; total: number }> {
  const match = toMatchExpression(args.query);
  const offset = args.offset ?? 0;
  const scope = scopeSql(args.scope ?? {}, 'n');
  const live = 'n.deleted_at IS NULL AND n.trashed_at IS NULL';
  // A non-blank query that tokenised to nothing (only quotes) matches nothing
  // — it must not fall through to the browse lane and present every note.
  if (match === '') return { hits: [], total: 0 };
  if (match === null) {
    // "Most recently updated" must see body edits. The local flush stamps
    // note.updated_at only on a derived-title change, so the newest
    // note_body_update row supplies the body's own clock.
    const recency =
      "max(n.updated_at, coalesce((SELECT max(b.created_at) FROM note_body_update b WHERE b.note_id = n.id), n.updated_at))";
    const rows = client
      .prepare(
        `SELECT n.id, n.title, coalesce(n.content_text, '') AS content_text, n.content_markdown, n.created_at, n.updated_at
            FROM note n WHERE ${live}${scope.where}
            ORDER BY ${recency} DESC, n.id DESC LIMIT ? OFFSET ?`
      )
      .all(...scope.args, Math.min(args.limit, SNIPPET_ROW_LIMIT), offset) as SearchRow[];
    const total = client
      .prepare(`SELECT count(*) AS total FROM note n WHERE ${live}${scope.where}`)
      .pluck()
      .get(...scope.args);
    return {
      hits: rows.map(row => ({
        noteId: asString(row.id),
        title: asString(row.title),
        contentText: asString(row.content_text),
        contentMarkdown: typeof row.content_markdown === 'string' ? row.content_markdown : null,
        rank: 0,
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      })),
      total: Number(total ?? 0),
    };
  }
  const rows = client
    .prepare(
      `SELECT n.id, n.title, coalesce(n.content_text, '') AS content_text, n.content_markdown, n.created_at, n.updated_at,
                 ${RANK} AS rank
          FROM note_fts f JOIN note n ON n.id = f.note_id
          WHERE note_fts MATCH ? AND ${live}${scope.where}
          ORDER BY rank, n.updated_at DESC LIMIT ? OFFSET ?`
    )
    .all(match, ...scope.args, Math.min(args.limit, SNIPPET_ROW_LIMIT), offset) as SearchRow[];
  const total = client
    .prepare(
      `SELECT count(*) AS total FROM note_fts f JOIN note n ON n.id = f.note_id
          WHERE note_fts MATCH ? AND ${live}${scope.where}`
    )
    .pluck()
    .get(match, ...scope.args);
  return {
    hits: rows.map(row => ({
      noteId: asString(row.id),
      title: asString(row.title),
      contentText: asString(row.content_text),
      contentMarkdown: typeof row.content_markdown === 'string' ? row.content_markdown : null,
      // bm25 is "lower is better" and negative for matches; flip to a positive score.
      rank: -Number(row.rank ?? 0),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
    })),
    total: Number(total ?? 0),
  };
}

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
const SEARCH_MAX_QUERY = 500;

const readInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

/**
 * GET /me/search?query&limit&offset returns
 * {success, results, total, query, limit, offset}, with `id === noteId`.
 * An empty query browses recent notes so the local palette can list them
 * without a network round trip.
 */
export const handleSearch = async (
  client: Database.Database,
  query: Record<string, string>
): Promise<RouteResult> => {
  const text = (query.query ?? '').trim();
  const limit = readInt(query.limit, SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
  const offset = readInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (text.length > SEARCH_MAX_QUERY || Number.isNaN(limit) || Number.isNaN(offset)) {
    return invalidRequest();
  }
  const { hits, total } = await searchNotes(client, { query: text, limit, offset });
  return ok({
    results: hits.map(hit => ({
      id: hit.noteId,
      noteId: hit.noteId,
      title: hit.title,
      contentText: hit.contentText,
      createdAt: hit.createdAt,
      updatedAt: hit.updatedAt,
    })),
    total,
    query: text,
    limit,
    offset,
  });
};
