// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { EditorState } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { getEditorSchema } from "@prismical/editor-schema";
import type { SkillDiffCandidate } from "./skill-diff-store";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// The preview builder is the seam: a candidate that can't be turned into a transaction is exactly
// the "can't render the diff right now" case this hook must survive without destroying anything.
const buildCandidateTransaction = vi.fn();
vi.mock("./build-decorations", () => ({
  buildCandidateTransaction: (...args: unknown[]) => buildCandidateTransaction(...args),
  buildDiffDecorations: () => "decorations",
}));

const { useSkillDiffDecorations } = await import("./use-skill-diff-decorations");
const { useSkillDiffStore } = await import("./skill-diff-store");

const NOTE = "nt_preview";
const schema = getEditorSchema();

// Frames are collected and drained on demand rather than fired inline - see `emitDocChange`.
const frames: FrameRequestCallback[] = [];
function flushFrames() {
  const queued = frames.splice(0);
  queued.forEach((cb) => cb(0));
}

function makeCandidate(): SkillDiffCandidate {
  return {
    noteId: NOTE,
    skillId: "skl_enhance",
    skillName: "Enhance",
    recordingId: "rec_1",
    mode: "append-section",
    modelId: "test-model",
    reasoning: null,
    refineInstruction: null,
    selectionText: null,
    content: [{ type: "paragraph", content: [{ type: "text", text: "proposal" }] }],
    rawMarkdown: "proposal",
  };
}

// A minimal stand-in for the TipTap editor: the hook only needs a live view (for `state.tr` +
// `dispatch`) and the transaction event it re-previews on.
function makeEditor() {
  const state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }],
    }),
  });
  const handlers = new Set<(payload: { transaction: { docChanged: boolean } }) => void>();
  const editor = {
    isDestroyed: false,
    state, // `clearDiffDecorations` reads the editor's own state, not the view's
    // `dom` is real: an append-section preview that succeeds scrolls to its first insert widget.
    view: { state, dispatch: vi.fn(), dom: document.createElement("div") },
    on: (_event: string, handler: (p: { transaction: { docChanged: boolean } }) => void) =>
      handlers.add(handler),
    off: (_event: string, handler: (p: { transaction: { docChanged: boolean } }) => void) =>
      handlers.delete(handler),
  };
  return {
    editor: editor as unknown as Editor,
    // Emits a doc change and then runs the frame the hook coalesces its rebuild into. Frames are
    // queued, never run inline: the hook stores the frame id and refuses to schedule a second while
    // one is outstanding, so an inline callback would leave a stale id and swallow later changes.
    emitDocChange: () => {
      handlers.forEach((h) => h({ transaction: { docChanged: true } }));
      flushFrames();
    },
  };
}

describe("useSkillDiffDecorations", () => {
  beforeEach(() => {
    toastError.mockClear();
    buildCandidateTransaction.mockReset();
    frames.length = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    useSkillDiffStore.setState({ candidatesByNote: new Map([[NOTE, makeCandidate()]]) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a candidate that cannot be previewed, and warns only once", () => {
    buildCandidateTransaction.mockReturnValue(null);
    const { editor, emitDocChange } = makeEditor();

    renderHook(() => useSkillDiffDecorations(editor, NOTE));

    // The staged result cost a model call: an unrenderable preview must not discard it.
    expect(useSkillDiffStore.getState().candidatesByNote.get(NOTE)).toBeDefined();
    expect(toastError).toHaveBeenCalledTimes(1);

    // Retries keep failing while the document is unusable — without stacking a toast per attempt.
    emitDocChange();
    emitDocChange();
    expect(useSkillDiffStore.getState().candidatesByNote.get(NOTE)).toBeDefined();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("drops an overlay it can no longer justify, and re-arms the warning", () => {
    const tr = { steps: [], doc: null as unknown };
    buildCandidateTransaction.mockReturnValue(tr);
    const { editor, emitDocChange } = makeEditor();
    const dispatch = editor.view.dispatch as unknown as ReturnType<typeof vi.fn>;

    renderHook(() => useSkillDiffDecorations(editor, NOTE));
    flushFrames(); // the append-section preview scrolls to its first insert on the next frame
    expect(dispatch).toHaveBeenCalledTimes(1); // decorated
    expect(toastError).not.toHaveBeenCalled();

    // The document moves somewhere the proposal can no longer be placed. The overlay was mapped
    // through that change and now claims a diff we can't rebuild, so it must go - the candidate
    // must not.
    buildCandidateTransaction.mockReturnValue(null);
    emitDocChange();
    expect(dispatch).toHaveBeenCalledTimes(2); // the "clear" meta
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(useSkillDiffStore.getState().candidatesByNote.get(NOTE)).toBeDefined();

    // Recovering re-arms the warning: the FIRST failure must not silence a later, real one.
    buildCandidateTransaction.mockReturnValue(tr);
    emitDocChange();
    buildCandidateTransaction.mockReturnValue(null);
    emitDocChange();
    expect(toastError).toHaveBeenCalledTimes(2);
  });

  it("recovers the overlay once the document can take the diff", () => {
    buildCandidateTransaction.mockReturnValueOnce(null);
    const { editor, emitDocChange } = makeEditor();

    renderHook(() => useSkillDiffDecorations(editor, NOTE));
    const dispatch = (editor as unknown as { view: { dispatch: ReturnType<typeof vi.fn> } }).view
      .dispatch;
    expect(dispatch).not.toHaveBeenCalled();

    // The doc settles (a late Y.Doc sync, a remote replace landing) and the preview builds.
    buildCandidateTransaction.mockReturnValue({ steps: [], doc: editor.view.state.doc });
    emitDocChange();
    expect(dispatch).toHaveBeenCalledTimes(1);

    // Recovered: a further change re-previews without a second failure toast.
    emitDocChange();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(useSkillDiffStore.getState().candidatesByNote.get(NOTE)).toBeDefined();
  });
});
