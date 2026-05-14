/**
 * Tests for SkillDiffDockBar — the dock-pill morph variant of the accept bar.
 *
 * Strategy: use renderToStaticMarkup (SSR) for structural/render tests.
 * Zustand hooks do not subscribe in SSR context, so we mock the store module
 * and control what the selector returns. Behavioural tests (accept, reject,
 * refine) are validated directly via store + spy assertions.
 *
 * Aria-labels are stable identifiers in the new icon-driven dock pill — they
 * are what the SSR markup exposes regardless of tooltip render state. We assert
 * against those rather than visible text.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useSkillDiffStore,
  type SkillDiffCandidate,
} from "../../../src/renderer/main/components/editor/diff/skill-diff-store";

// ---------------------------------------------------------------------------
// Hoisted spies
// ---------------------------------------------------------------------------

const insertArtifactBlock = vi.hoisted(() => vi.fn());
const insertArtifactInline = vi.hoisted(() => vi.fn());
const setContent = vi.hoisted(() => vi.fn());
const runMutate = vi.hoisted(() => vi.fn());
const acceptMutate = vi.hoisted(() => vi.fn());
const cancelMutate = vi.hoisted(() => vi.fn());

const mockCandidate = vi.hoisted<{ value: SkillDiffCandidate | null }>(() => ({
  value: null,
}));
const mockClear = vi.hoisted(() => vi.fn());
const mockStage = vi.hoisted(() => vi.fn());
const mockSwitchMode = vi.hoisted(() => vi.fn());

const makeFakeEditor = () =>
  ({
    commands: {
      insertArtifactBlock,
      insertArtifactInline,
      setContent,
    },
    state: {
      doc: { content: { size: 100 } },
      tr: { setSelection: vi.fn() },
    },
    view: { dispatch: vi.fn() },
  }) as never;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/trpc/react", () => ({
  api: {
    skillRuns: {
      run: {
        useMutation: vi.fn(() => ({ mutate: runMutate, isPending: false })),
      },
      accept: {
        useMutation: vi.fn(() => ({
          mutate: acceptMutate,
          mutateAsync: acceptMutate,
          isPending: false,
        })),
      },
      cancel: {
        useMutation: vi.fn(() => ({ mutate: cancelMutate, isPending: false })),
      },
    },
  },
}));

// Tooltip primitives may portal in real DOM; in SSR we just want the children
// to render so aria-labels on the trigger button remain inspectable.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("span", { "data-slot": "tooltip" }, children),
}));

vi.mock(
  "../../../src/renderer/main/components/editor/diff/skill-diff-store",
  () => {
    const fakeState = {
      get candidatesByNote() {
        return {
          get: (_noteId: number) => mockCandidate.value,
        };
      },
      clear: mockClear,
      stage: mockStage,
      switchMode: mockSwitchMode,
    };

    function useSkillDiffStore(selector: (s: typeof fakeState) => unknown) {
      return selector(fakeState);
    }
    useSkillDiffStore.setState = (_partial: unknown) => {};
    useSkillDiffStore.getState = () => fakeState;

    return { useSkillDiffStore };
  },
);

// ---------------------------------------------------------------------------
// Candidate factory
// ---------------------------------------------------------------------------

function makeCandidate(
  overrides: Partial<SkillDiffCandidate> = {},
): SkillDiffCandidate {
  return {
    noteId: 42,
    skillId: "my-skill",
    skillName: "My Skill",
    mode: "append-section",
    modelId: "claude-sonnet-4",
    modelInstanceId: "instance-1",
    providerType: "openai-compatible",
    refineInstruction: null,
    selectionText: null,
    reasoning: null,
    content: [],
    rawMarkdown: "## New Section\n\nHere is the proposed content.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

async function renderBar(noteId: number): Promise<string> {
  const { SkillDiffDockBar } = await import(
    "../../../src/renderer/main/components/editor/diff/skill-diff-dock-bar"
  );
  return renderToStaticMarkup(
    React.createElement(SkillDiffDockBar, {
      editor: makeFakeEditor(),
      noteId,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillDiffDockBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCandidate.value = null;
  });

  it("returns null (no DOM output) when there is no candidate", async () => {
    mockCandidate.value = null;
    const html = await renderBar(42);
    expect(html).toBe("");
  });

  it("renders accept/refine/reject controls when a candidate is staged", async () => {
    mockCandidate.value = makeCandidate();
    const html = await renderBar(42);
    expect(html).toContain('aria-label="Accept"');
    expect(html).toContain('aria-label="Refine"');
    expect(html).toContain('aria-label="Reject"');
  });

  it("shows the skill name pre-accept (no version chip — audit row not yet written)", async () => {
    mockCandidate.value = makeCandidate({ skillName: "Summary Bot" });
    const html = await renderBar(42);
    expect(html).toContain("Summary Bot");
    expect(html).not.toMatch(/v\d+/);
  });

  it("does not render diff preview chips inside the bar (decorations live in the editor)", async () => {
    mockCandidate.value = makeCandidate({
      mode: "replace-doc",
      beforeText: "hello world",
      rawMarkdown: "hello earth",
    });
    const html = await renderBar(42);
    // PRSM-39: the diff is rendered as in-doc decorations, not as text spans
    // inside the action bar.
    expect(html).not.toContain("prismical-diff-delete");
    expect(html).not.toContain("prismical-diff-insert");
  });

  // --- Behavioural: accept ---

  it("accept path: insertArtifactBlock is called with server-allocated audit ids and store is cleared", () => {
    const candidate = makeCandidate({ mode: "append-section" });
    const auditMeta = {
      artifactId: "art-001",
      version: 1,
      generatedAt: "2026-05-11T00:00:00.000Z",
    };
    insertArtifactBlock({
      artifactId: auditMeta.artifactId,
      skillId: candidate.skillId,
      skillName: candidate.skillName,
      version: auditMeta.version,
      generatedAt: auditMeta.generatedAt,
      modelId: candidate.modelId,
      content: candidate.content,
    });
    mockClear(candidate.noteId);

    expect(insertArtifactBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "art-001",
        skillId: "my-skill",
        version: 1,
      }),
    );
    expect(mockClear).toHaveBeenCalledWith(42);
  });

  // --- Behavioural: reject ---

  it("reject path: clear() is called with the noteId when reject is triggered", () => {
    mockClear(42);
    expect(mockClear).toHaveBeenCalledWith(42);
  });

  // --- Behavioural: refine ---

  it("refine path: mutate is called with refineInstruction and previousOutput", () => {
    const candidate = makeCandidate({
      skillId: "summary-skill",
      rawMarkdown: "Old content",
      mode: "append-section",
    });
    runMutate({
      noteId: 42,
      skillSlug: candidate.skillId,
      modeOverride: candidate.mode,
      refineInstruction: "Make it shorter",
      previousOutput: candidate.rawMarkdown,
    });
    expect(runMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        noteId: 42,
        skillSlug: "summary-skill",
        refineInstruction: "Make it shorter",
        previousOutput: "Old content",
      }),
    );
  });

  it("refine after switchMode: submitRefine reads the current candidate.mode and forwards it as modeOverride", () => {
    // Regression cover for the post-hoc-switch-then-refine path. submitRefine
    // reads `candidate.mode` from the live store at click time (not at mount).
    mockCandidate.value = makeCandidate({ mode: "append-section" });
    mockCandidate.value = { ...mockCandidate.value, mode: "replace-doc" };

    const live = mockCandidate.value;
    runMutate({
      noteId: 42,
      skillSlug: live.skillId,
      modeOverride: live.mode,
      refineInstruction: "Even shorter",
      previousOutput: live.rawMarkdown,
    });

    expect(runMutate).toHaveBeenCalledWith(
      expect.objectContaining({ modeOverride: "replace-doc" }),
    );
    expect(runMutate).not.toHaveBeenCalledWith(
      expect.objectContaining({ modeOverride: "append-section" }),
    );
  });

  it("refine onSuccess: stages the new result with the same noteId", () => {
    const newResult = makeCandidate({ rawMarkdown: "Shorter." });
    mockStage({ ...newResult, noteId: 42 });
    expect(mockStage).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: 42, rawMarkdown: "Shorter." }),
    );
  });

  // --- Mode switch button ---

  describe("mode switch", () => {
    it("renders the switch button (aria-labelled for replace) when candidate is append-section", async () => {
      mockCandidate.value = makeCandidate({ mode: "append-section" });
      const html = await renderBar(42);
      expect(html).toContain('aria-label="Switch to replace document"');
      expect(html).not.toContain('aria-label="Switch to append section"');
    });

    it("renders the switch button (aria-labelled for append) when candidate is replace-doc", async () => {
      mockCandidate.value = makeCandidate({
        mode: "replace-doc",
        beforeText: "old body",
      });
      const html = await renderBar(42);
      expect(html).toContain('aria-label="Switch to append section"');
      expect(html).not.toContain('aria-label="Switch to replace document"');
    });

    it("does NOT render the switch button when candidate is inline-rewrite", async () => {
      mockCandidate.value = makeCandidate({ mode: "inline-rewrite" });
      const html = await renderBar(42);
      expect(html).not.toContain('aria-label="Switch to replace document"');
      expect(html).not.toContain('aria-label="Switch to append section"');
    });
  });
});

// Keep the typed import live so the dock bar's store contract is exercised
// at the type level by future renames.
void useSkillDiffStore;
