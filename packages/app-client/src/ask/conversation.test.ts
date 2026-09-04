import { describe, expect, it } from "vitest";
import { mintConversationId, toUiMessages } from "./conversation";
import { uiMessageText } from "./scope";

describe("mintConversationId", () => {
  it("mints a cnv_-prefixed id", () => {
    expect(mintConversationId()).toMatch(/^cnv_[a-z0-9]+$/);
  });

  it("mints a unique id each call", () => {
    expect(mintConversationId()).not.toBe(mintConversationId());
  });
});

describe("toUiMessages", () => {
  it("maps {role,content} to UIMessages with text parts and stable derived ids", () => {
    const out = toUiMessages(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      "cnv_x",
    );
    expect(out).toEqual([
      { id: "cnv_x:0", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "cnv_x:1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("round-trips text through uiMessageText", () => {
    const [m] = toUiMessages([{ role: "user", content: "round trip" }], "cnv_y");
    expect(uiMessageText(m!)).toBe("round trip");
  });

  it("returns [] for empty history", () => {
    expect(toUiMessages([], "cnv_z")).toEqual([]);
  });
});
