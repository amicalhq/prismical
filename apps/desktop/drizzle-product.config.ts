import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations for the PRODUCT stores (local.db + the per-(sub, org)
// cloud caches; see src/main/infra/product-db/). Versioned independently of the
// operational store's ./drizzle out dir — the two DBs have separate schema_meta
// ledgers and separate MIGRATIONS arrays. The generated .sql files are embedded
// into the main bundle via `?raw` imports (product-db/migrations.ts); the
// note_fts FTS5 DDL + triggers are hand-appended there (drizzle cannot model
// virtual tables — NEVER run drizzle-kit push against a product DB).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/infra/product-db/schema.ts',
  out: './drizzle-product',
});
