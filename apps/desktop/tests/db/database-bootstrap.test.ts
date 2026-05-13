import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@db/schema";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";

describe("Database Bootstrap", () => {
  let testDb: TestDatabase | undefined;

  afterEach(async () => {
    if (!testDb) {
      return;
    }

    await testDb.close();
    await deleteTestDatabase(testDb.dbPath);
    testDb = undefined;
  });

  it("creates the current schema from drizzle migrations", async () => {
    testDb = await createTestDatabase({ name: "database-bootstrap-test.db" });

    const tablesResult = await testDb.db.$client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const tableNames = tablesResult.rows.map((row) => String(row.name));

    expect(tableNames).toEqual(
      expect.arrayContaining([
        "__drizzle_migrations",
        "app_settings",
        "events",
        "instances",
        "meeting_artifacts",
        "meetings",
        "artifacts",
        "notes",
        "transcript_segments",
        "transcriptions",
        "vocabulary",
        "yjs_updates",
      ]),
    );

    const migrationsResult = await testDb.db.$client.execute(
      "SELECT count(*) AS count FROM __drizzle_migrations",
    );
    expect(Number(migrationsResult.rows[0]?.count ?? 0)).toBeGreaterThan(0);

    const appSettingsColumns = await testDb.db.$client.execute(
      "PRAGMA table_info(app_settings)",
    );
    const columnNames = appSettingsColumns.rows.map((row) => String(row.name));
    expect(columnNames).toContain("version");
  });

  it("stores app settings with version 1 by default", async () => {
    testDb = await createTestDatabase({
      name: "database-bootstrap-settings-test.db",
    });

    await testDb.db.insert(schema.appSettings).values({
      id: 1,
      data: {
        preferences: {
          launchAtLogin: true,
        },
      },
    });

    const [settings] = await testDb.db.select().from(schema.appSettings);
    expect(settings?.data.preferences?.launchAtLogin).toBe(true);
    expect(settings?.version).toBe(1);
  });
});
