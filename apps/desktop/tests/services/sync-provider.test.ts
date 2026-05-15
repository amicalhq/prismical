import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { NoteSyncProvider } from "@/renderer/main/providers/sync-provider";
import { COLLAB_FRAGMENT_NAME } from "@/services/notes/markdown-to-ydoc";

const saveYjsUpdate = vi.fn().mockResolvedValue(undefined);
const loadYjsUpdates = vi.fn().mockResolvedValue([]);
const setNoteMarkdown = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  saveYjsUpdate.mockClear();
  loadYjsUpdates.mockClear();
  setNoteMarkdown.mockClear();
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: {
      notes: { saveYjsUpdate, loadYjsUpdates, setNoteMarkdown },
    },
  };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("NoteSyncProvider", () => {
  it("exposes getDoc() returning a Y.Doc", () => {
    const p = new NoteSyncProvider({ noteId: 1 });
    expect(typeof p.getDoc).toBe("function");
    const doc = p.getDoc();
    expect(doc).toBeInstanceOf(Y.Doc);
    p.destroy();
  });

  it("batches multiple Y.Doc updates over the 150ms window into one IPC", async () => {
    const p = new NoteSyncProvider({ noteId: 1 });
    const fragment = p.getDoc().getXmlFragment(COLLAB_FRAGMENT_NAME);

    // Three quick edits, no time passes
    p.getDoc().transact(() => fragment.insert(0, [new Y.XmlText()]));
    p.getDoc().transact(() => (fragment.get(0) as Y.XmlText).insert(0, "a"));
    p.getDoc().transact(() => (fragment.get(0) as Y.XmlText).insert(1, "b"));

    expect(saveYjsUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(160);
    expect(saveYjsUpdate).toHaveBeenCalledTimes(1);

    // The merged update decodes back into a doc whose fragment has 1 child
    const [, mergedBuf] = saveYjsUpdate.mock.calls[0];
    const verifierDoc = new Y.Doc();
    Y.applyUpdate(verifierDoc, new Uint8Array(mergedBuf));
    expect(verifierDoc.getXmlFragment(COLLAB_FRAGMENT_NAME).length).toBe(1);

    p.destroy();
  });

  it("fires markdown sidecar IPC after 1.5s of idle", async () => {
    const editor = { getJSON: () => ({ type: "doc", content: [] }) } as unknown as import("@tiptap/core").Editor;
    const p = new NoteSyncProvider({ noteId: 1, editor });
    const fragment = p.getDoc().getXmlFragment(COLLAB_FRAGMENT_NAME);
    fragment.insert(0, [new Y.XmlText()]);

    await vi.advanceTimersByTimeAsync(200);
    expect(setNoteMarkdown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1400);
    expect(setNoteMarkdown).toHaveBeenCalledTimes(1);

    p.destroy();
  });

  it("destroy() flushes pending Yjs updates and markdown before tearing down", async () => {
    const editor = { getJSON: () => ({ type: "doc", content: [] }) } as unknown as import("@tiptap/core").Editor;
    const p = new NoteSyncProvider({ noteId: 1, editor });
    const fragment = p.getDoc().getXmlFragment(COLLAB_FRAGMENT_NAME);

    fragment.insert(0, [new Y.XmlText()]);
    expect(saveYjsUpdate).not.toHaveBeenCalled();
    expect(setNoteMarkdown).not.toHaveBeenCalled();

    p.destroy();

    // Drain microtasks so the void-flushed promises resolve enough to record
    // the mock invocations. The mocks fire synchronously on call, so we just
    // need enough ticks for the async function bodies to reach their first
    // await.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(saveYjsUpdate).toHaveBeenCalledTimes(1);
    expect(setNoteMarkdown).toHaveBeenCalledTimes(1);
  });

  it("requeues and retries when saveYjsUpdate rejects, firing onSaveError", async () => {
    const onSaveError = vi.fn();
    // Fail the first call, succeed the second.
    saveYjsUpdate
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const p = new NoteSyncProvider({ noteId: 1, onSaveError });
    const fragment = p.getDoc().getXmlFragment(COLLAB_FRAGMENT_NAME);

    // Generate one update.
    fragment.insert(0, [new Y.XmlText()]);

    // First flush attempt — fails, requeues, reschedules, fires onSaveError.
    await vi.advanceTimersByTimeAsync(160);
    expect(saveYjsUpdate).toHaveBeenCalledTimes(1);
    expect(onSaveError).toHaveBeenCalledTimes(1);

    // Second flush attempt fires after another window — succeeds, drains.
    await vi.advanceTimersByTimeAsync(160);
    expect(saveYjsUpdate).toHaveBeenCalledTimes(2);
    // Same merged content on retry (compare by length is sufficient — both
    // calls' second arg is the same ArrayBuffer derived from the same merged
    // Uint8Array).
    const firstBuf = saveYjsUpdate.mock.calls[0][1] as ArrayBuffer;
    const secondBuf = saveYjsUpdate.mock.calls[1][1] as ArrayBuffer;
    expect(secondBuf.byteLength).toBe(firstBuf.byteLength);

    // onSaveError must NOT fire again on the successful retry.
    expect(onSaveError).toHaveBeenCalledTimes(1);

    p.destroy();
  });
});
