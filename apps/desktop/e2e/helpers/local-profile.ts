import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Seeded mode profiles. A truly fresh e2e profile
 * boots into the first-run mode CHOOSER (the `app:mode` operational KV row is
 * absent ⇒ AppModeLive resolves 'cloud', unchosen), so a spec that wants the
 * sign-in gate or the local shell needs a PRE-SEEDED userData dir: this mints
 * one and writes `<dir>/operational.db` holding only the version-0 tables plus
 * the `app:mode = <mode>` settings row, then the caller launches with
 * `launchPrismical({ PRISMICAL_E2E_USER_DATA_DIR: dir })` (launchPrismical
 * seeds 'cloud' itself for the profiles it mints).
 *
 * The seed shape mirrors tests/services/operational-db.test.ts (the proven
 * "settings-only DB" upgrade fixture) EXACTLY: the DDL is inlined because the
 * app's migrator embeds drizzle/*.sql via vite `?raw` imports, dead under
 * Playwright's transpiler. Recording version 0 in schema_meta is mandatory —
 * 0000_init.sql creates `settings` without IF NOT EXISTS, so boot's migrator
 * must see 0 as already applied (it then runs 1..n normally). The mode value
 * is the RAW string: OperationalDb.getSetting returns the stored TEXT
 * verbatim and AppModeLive matches it against 'local'/'cloud' — a JSON-quoted
 * '"local"' is a pinned MALFORMED case that silently boots cloud, unchosen.
 */
export type SeededAppMode = 'local' | 'cloud';

/** Write the version-0 operational store with the mode row into an existing dir. */
export function seedAppMode(dir: string, mode: SeededAppMode): void {
  const db = new DatabaseSync(path.join(dir, 'operational.db'));
  const now = new Date().toISOString();
  try {
    db.exec(
      'CREATE TABLE `schema_meta` (`version` integer PRIMARY KEY NOT NULL, `name` text NOT NULL, `applied_at` text NOT NULL)'
    );
    db.exec(
      'CREATE TABLE `settings` (`key` text PRIMARY KEY NOT NULL, `value` text NOT NULL, `updated_at` text NOT NULL)'
    );
    db.prepare('INSERT INTO schema_meta (version, name, applied_at) VALUES (?, ?, ?)').run(
      0,
      'init',
      now
    );
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'app:mode',
      mode,
      now
    );
  } finally {
    db.close();
  }
}

/** A fresh temp profile pre-seeded with the given mode. */
export async function createSeededProfile(mode: SeededAppMode): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `prismical-e2e-${mode}-`));
  seedAppMode(dir, mode);
  return dir;
}

/** The local-mode twin every local spec boots from. */
export const createLocalModeProfile = (): Promise<string> => createSeededProfile('local');
