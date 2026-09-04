import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Client-side managed-provider disclosure guard.
 *
 * `createRecording` writes `transcriptionConfig` and the server stores it verbatim, so whatever
 * this function names is (a) shipped inside the web bundle for anyone to read and (b) echoed back
 * on every recording read. Which engine Prismical Cloud routes a managed recording to is a
 * server-side decision and is not disclosed.
 *
 * This test is deliberately written against the SENT PAYLOAD rather than the source text, because
 * the same model names legitimately appear elsewhere in the client for LOCAL, on-device Whisper
 * downloads the user picks themselves — a blanket string ban would fight that forever.
 */
const post = vi.fn((_path: string, _body: Record<string, unknown>) => Promise.resolve({}));
vi.mock("./client", () => ({
  apiClient: {
    post: (path: string, body: Record<string, unknown>) => post(path, body),
  },
  ME_PREFIX: "/apps/v1/me",
}));

const { createRecording } = await import("./transcription");

const sentBody = (): Record<string, unknown> =>
  (post.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];

beforeEach(() => post.mockClear());

describe("createRecording — managed (Prismical Cloud)", () => {
  it("sends only the public managed transcription configuration", async () => {
    await createRecording({ noteId: "note_1", title: "Standup" });
    expect(sentBody()).toStrictEqual({
      title: "Standup",
      captureMode: "mic",
      status: "recording",
      noteId: "note_1",
      startedAt: expect.any(Number),
      transcriptionConfig: {
        provider: "prismical-cloud",
        model: "prismical-cloud",
        language: "multi",
      },
    });
  });

  it("sends an explicitly selected transcription language", async () => {
    await createRecording({ noteId: "note_1", title: "Standup", language: "es" });
    const config = sentBody().transcriptionConfig as Record<string, unknown>;
    expect(config.language).toBe("es");
  });
});

describe("createRecording — BYOK", () => {
  it("carries the owner's own instance and model, unredacted", async () => {
    // The user chose this model and pays for it directly; hiding it would hide their own setup.
    await createRecording({
      noteId: "note_1",
      title: "Standup",
      instanceId: "ins_abc",
      modelId: "gpt-4o-transcribe",
    });
    const config = sentBody().transcriptionConfig as Record<string, unknown>;
    expect(config.provider).toBe("byok");
    expect(config.model).toBe("gpt-4o-transcribe");
    expect(config.instanceId).toBe("ins_abc");
    expect(config.modelId).toBe("gpt-4o-transcribe");
  });
});
