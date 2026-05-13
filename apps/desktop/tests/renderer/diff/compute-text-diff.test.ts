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

  it("word substitution → whole word replaced (word-level diff, not char-level)", () => {
    // Word-level diff treats "hello" and "hallo" as different tokens entirely:
    // the whole word is one delete + one insert, not a per-char swap. This is
    // intentional — char-level produces interleaved scribbles on real prose.
    const spans = computeTextDiff("hello world", "hallo world");

    const deletes = spans.filter((s) => s.kind === "delete");
    const inserts = spans.filter((s) => s.kind === "insert");

    expect(deletes).toHaveLength(1);
    expect(deletes[0].text).toBe("hello");

    expect(inserts).toHaveLength(1);
    expect(inserts[0].text).toBe("hallo");

    // The unchanged " world" survives as an equal span.
    const equalText = spans.filter((s) => s.kind === "equal").map((s) => s.text).join("");
    expect(equalText).toBe(" world");
  });

  it("completely different strings → no equal spans", () => {
    const spans = computeTextDiff("abc", "xyz");
    const equalSpans = spans.filter((s) => s.kind === "equal");
    expect(equalSpans).toHaveLength(0);
  });
});
