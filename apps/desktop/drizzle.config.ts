import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations for the local operational store (see
// src/main/infra/operational-db/). The generated .sql files are embedded into
// the main bundle via `?raw` imports (migrations.ts) so the packaged app never
// needs a migrations folder on disk.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/infra/operational-db/schema.ts',
  out: './drizzle',
});
