import { describe, expect, it } from "vitest";

describe("editor/slash-menu/items", () => {
  it("exports SLASH_MENU_ITEMS with the expected labels in order", async () => {
    const { SLASH_MENU_ITEMS } = await import(
      "@/renderer/main/components/editor/slash-menu/slash-menu-items"
    );
    const labels = SLASH_MENU_ITEMS.map(
      (i: { label: string }) => i.label,
    );
    expect(labels).toEqual([
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Bullet list",
      "Numbered list",
      "Check list",
      "Quote",
      "Code block",
      "Divider",
      "Table",
    ]);
  });

  it("every item has label, keywords[], icon, and run()", async () => {
    const { SLASH_MENU_ITEMS } = await import(
      "@/renderer/main/components/editor/slash-menu/slash-menu-items"
    );
    for (const item of SLASH_MENU_ITEMS as Array<Record<string, unknown>>) {
      expect(typeof item.label).toBe("string");
      expect(Array.isArray(item.keywords)).toBe(true);
      expect(item.icon).toBeDefined();
      expect(typeof item.run).toBe("function");
    }
  });

  it("filterSlashItems is case-insensitive over label + keywords", async () => {
    const { filterSlashItems } = await import(
      "@/renderer/main/components/editor/slash-menu/slash-menu-items"
    );
    expect(filterSlashItems("h1").map((i) => i.label)).toContain("Heading 1");
    const listMatches = filterSlashItems("list").map((i) => i.label);
    expect(listMatches).toContain("Bullet list");
    expect(listMatches).toContain("Numbered list");
    expect(listMatches).toContain("Check list");
    expect(filterSlashItems("CODE").map((i) => i.label)).toContain("Code block");
    expect(filterSlashItems("").length).toBe(10);
    expect(filterSlashItems("zzzzzz")).toEqual([]);
  });
});
