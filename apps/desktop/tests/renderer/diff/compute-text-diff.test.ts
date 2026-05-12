import { describe, expect, it } from "vitest";
import {
  computeTextDiff,
  type DiffSpan,
} from "../../../src/renderer/main/components/editor/diff/compute-text-diff";

describe("computeTextDiff", () => {
  it("empty before + non-empty after → all spans are insert", () => {
    const spans = computeTextDiff("", "hello world");
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.kind).toBe("insert");
    }
    const text = spans.map((s) => s.text).join("");
    expect(text).toBe("hello world");
  });

  it("identical before/after → single equal span", () => {
    const spans = computeTextDiff("hello", "hello");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual<DiffSpan>({ text: "hello", kind: "equal" });
  });

  it("trailing char added → last span is insert with that char", () => {
    const spans = computeTextDiff("hello world", "hello world!");
    const insertSpans = spans.filter((s) => s.kind === "insert");
    expect(insertSpans).toHaveLength(1);
    expect(insertSpans[0].text).toBe("!");

    const equalSpans = spans.filter((s) => s.kind === "equal");
    expect(equalSpans.map((s) => s.text).join("")).toBe("hello world");
  });

  it("char substitution → one delete + one insert for changed char", () => {
    // "hello" vs "hallo": 'e' removed, 'a' inserted
    const spans = computeTextDiff("hello", "hallo");

    const deletes = spans.filter((s) => s.kind === "delete");
    const inserts = spans.filter((s) => s.kind === "insert");

    expect(deletes).toHaveLength(1);
    expect(deletes[0].text).toBe("e");

    expect(inserts).toHaveLength(1);
    expect(inserts[0].text).toBe("a");

    // Verify order: equal "h", delete "e", insert "a", equal "llo"
    const kinds = spans.map((s) => s.kind);
    expect(kinds[0]).toBe("equal"); // "h"
    // delete and insert may appear in either order depending on diff algo
    const middleKinds = new Set(kinds.slice(1, -1));
    expect(middleKinds.has("delete")).toBe(true);
    expect(middleKinds.has("insert")).toBe(true);
    expect(kinds[kinds.length - 1]).toBe("equal"); // "llo"
  });

  it("completely different strings → no equal spans", () => {
    const spans = computeTextDiff("abc", "xyz");
    const equalSpans = spans.filter((s) => s.kind === "equal");
    expect(equalSpans).toHaveLength(0);
  });
});
