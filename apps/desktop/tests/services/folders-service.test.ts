import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  deleteTestDatabase,
  type TestDatabase,
} from "../helpers/test-db";
import { FoldersService } from "@/services/folders-service";

let testDb: TestDatabase;
let service: FoldersService;

beforeEach(async () => {
  testDb = await createTestDatabase({ name: `folders-svc-${Date.now()}.db` });
  service = new FoldersService(testDb.db);
});
afterEach(async () => {
  await testDb.close();
  await deleteTestDatabase(testDb.dbPath);
});

describe("FoldersService", () => {
  it("createFolder trims whitespace and stores user casing", async () => {
    const f = await service.createFolder({ name: "  Work Projects  " });
    expect(f.name).toBe("Work Projects");
  });

  it("createFolder rejects empty/oversized names", async () => {
    await expect(service.createFolder({ name: "" })).rejects.toThrow(
      /required/i,
    );
    await expect(service.createFolder({ name: "   " })).rejects.toThrow(
      /required/i,
    );
    await expect(service.createFolder({ name: "x".repeat(65) })).rejects.toThrow(
      /64/,
    );
  });

  it("createFolder returns existing folder on case-insensitive name collision", async () => {
    const a = await service.createFolder({ name: "Work" });
    const b = await service.createFolder({ name: "WORK" });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("Work"); // existing display name preserved
  });

  it("updateFolder validates name and stores trimmed value", async () => {
    const a = await service.createFolder({ name: "A" });
    const updated = await service.updateFolder(a.id, { name: "  Renamed  " });
    expect(updated.name).toBe("Renamed");
    await expect(
      service.updateFolder(a.id, { name: "" }),
    ).rejects.toThrow(/required/i);
  });

  it("updateFolder rejects rename that collides with another folder (case-insensitive)", async () => {
    await service.createFolder({ name: "Work" });
    const b = await service.createFolder({ name: "Personal" });
    await expect(
      service.updateFolder(b.id, { name: "WORK" }),
    ).rejects.toThrow(/already exists/i);
  });

  it("toggleFavorite flips isFavorite", async () => {
    const a = await service.createFolder({ name: "A" });
    const f1 = await service.updateFolder(a.id, { isFavorite: true });
    expect(f1.isFavorite).toBe(true);
    const f2 = await service.updateFolder(a.id, { isFavorite: false });
    expect(f2.isFavorite).toBe(false);
  });
});
