import { describe, expect, it } from "vitest";
import { applyMention, parseMention } from "./mention";

describe("parseMention", () => {
  it("matches a bare @ at the caret", () => {
    expect(parseMention("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });
  it("matches @ after whitespace with a query", () => {
    expect(parseMention("hi @ro", 6)).toEqual({ start: 3, end: 6, query: "ro" });
  });
  it("returns the partial query as the caret moves", () => {
    expect(parseMention("hi @ro", 5)).toEqual({ start: 3, end: 5, query: "r" });
  });
  it("does not match once a space follows the @ (committed mention)", () => {
    expect(parseMention("@Q3 Roadmap", 11)).toBeNull();
  });
  it("does not match an email-style @ (no preceding whitespace)", () => {
    expect(parseMention("email@x", 7)).toBeNull();
  });
  it("returns null when the caret is in a plain word", () => {
    expect(parseMention("hello world", 5)).toBeNull();
  });
  it("returns null at the very start (caret 0)", () => {
    expect(parseMention("@hi", 0)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the token with @<label> and a trailing space at end of input", () => {
    expect(applyMention("summarize @q3", { start: 10, end: 13 }, "Q3 Roadmap")).toEqual({
      value: "summarize @Q3 Roadmap ",
      caret: 22,
    });
  });
  it("does not double the space when one already follows", () => {
    expect(applyMention("a @b end", { start: 2, end: 4 }, "Beta")).toEqual({
      value: "a @Beta end",
      caret: 7,
    });
  });
  it("handles a bare @ at the start", () => {
    expect(applyMention("@", { start: 0, end: 1 }, "Notes")).toEqual({
      value: "@Notes ",
      caret: 7,
    });
  });
});
