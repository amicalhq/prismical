import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { aiUserErrorOf, bindAiErrorActions, isNetworkFailure } from "./ai-user-error";

describe("aiUserErrorOf", () => {
  it("reads the server-rendered description off an AI error envelope", () => {
    const err = new ApiError("PROVIDER_KEY_INVALID", "The provider rejected the API key", 422, {
      lane: "your-key",
      provider: "openai",
      user: {
        title: "Your OpenAI key was rejected.",
        body: "Update it in Settings, or use Prismical Cloud for now.",
        severity: "warning",
        actions: [
          { kind: "open-ai-models", label: "Open AI models" },
          { kind: "use-cloud", label: "Use Prismical Cloud" },
        ],
      },
    });
    expect(aiUserErrorOf(err)).toMatchObject({
      title: "Your OpenAI key was rejected.",
      severity: "warning",
    });
  });

  it("returns null for older servers (no user block), malformed blocks, and non-API errors", () => {
    expect(
      aiUserErrorOf(new ApiError("NOTE_EMPTY", "empty", 422, { includesTranscript: true })),
    ).toBeNull();
    expect(aiUserErrorOf(new ApiError("X", "x", 500, { user: { title: "" } }))).toBeNull();
    expect(aiUserErrorOf(new Error("boom"))).toBeNull();
  });
});

describe("bindAiErrorActions", () => {
  it("binds known kinds in the server's order and drops kinds this client cannot perform", () => {
    const open = vi.fn();
    const bound = bindAiErrorActions(
      [
        { kind: "use-cloud", label: "Use Prismical Cloud" },
        { kind: "open-ai-models", label: "Open AI models" },
        { kind: "teleport", label: "From a newer core" },
      ],
      { "open-ai-models": open },
    );
    expect(bound.map((a) => a.kind)).toEqual(["open-ai-models"]);
    bound[0]!.onClick();
    expect(open).toHaveBeenCalledOnce();
  });
});

describe("isNetworkFailure", () => {
  it("recognises a fetch that never got a response", () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkFailure(new ApiError("INTERNAL", "transport", 0))).toBe(true);
    expect(isNetworkFailure(new ApiError("NOTE_EMPTY", "empty", 422))).toBe(false);
  });
});
