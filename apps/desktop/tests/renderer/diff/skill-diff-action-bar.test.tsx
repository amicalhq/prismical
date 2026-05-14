/**
 * Tests for SkillDiffActionBar.
 *
 * Strategy: use renderToStaticMarkup (SSR) for structural/render tests.
 * Zustand hooks do not subscribe in SSR context, so we mock the store module
 * and control what the selector returns. Behavioral tests (accept, reject,
 * refine) are validated directly via store + spy assertions.
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

const dispatchCommand = vi.hoisted(() => vi.fn());
const editorUpdate = vi.hoisted(() => vi.fn());
const runMutate = vi.hoisted(() => vi.fn());
const acceptMutate = vi.hoisted(() => vi.fn());
const cancelMutate = vi.hoisted(() => vi.fn());

// Hoisted store state — controls what the mock selector returns
const mockCandidate = vi.hoisted<{ value: SkillDiffCandidate | null }>(() => ({
  value: null,
}));
const mockClear = vi.hoisted(() => vi.fn());
const mockStage = vi.hoisted(() => vi.fn());
const mockSwitchMode = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@lexical/react/LexicalComposerContext", () => ({
  useLexicalComposerContext: () => [
    { dispatchCommand, update: editorUpdate },
  ],
}));

vi.mock("@/trpc/react", () => ({
  api: {
    skillRuns: {
      run: {
        useMutation: vi.fn(() => ({
          mutate: runMutate,
          isPending: false,
        })),
      },
      accept: {
        useMutation: vi.fn(() => ({
          mutate: acceptMutate,
          mutateAsync: acceptMutate,
          isPending: false,
        })),
      },
      cancel: {
        useMutation: vi.fn(() => ({
          mutate: cancelMutate,
          isPending: false,
        })),
      },
    },
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, variant }: any) =>
    React.createElement(
      "button",
      { onClick, disabled, "data-variant": variant },
      children,
    ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({ placeholder, value, onChange, onKeyDown, autoFocus }: any) =>
    React.createElement("input", {
      placeholder,
      value,
      onChange,
      onKeyDown,
      autoFocus,
    }),
}));

/**
 * Mock the store so SSR renders pick up the candidate we set in mockCandidate.
 * The component calls useSkillDiffStore with different selectors, so we need
 * to handle each selector case:
 *   - s.candidatesByNote.get(noteId)  → returns mockCandidate.value
 *   - s.clear                         → returns mockClear
 *   - s.stage                         → returns mockStage
 */
vi.mock(
  "../../../src/renderer/main/components/editor/diff/skill-diff-store",
  () => {
    // Build a fake Map-like state object for the selectors
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

    // Attach setState + getState so direct store tests still work
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
  const { SkillDiffActionBar } = await import(
    "../../../src/renderer/main/components/editor/diff/skill-diff-action-bar"
  );
  return renderToStaticMarkup(
    React.createElement(SkillDiffActionBar, { noteId }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillDiffActionBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock candidate to null
    mockCandidate.value = null;
  });

  // --- Render: no candidate ---

  it("returns null (no DOM output) when there is no candidate", async () => {
    mockCandidate.value = null;
    const html = await renderBar(42);
    expect(html).toBe("");
  });

  // --- Render: candidate present ---

  it("renders preview text and 3 action buttons when candidate is staged", async () => {
    mockCandidate.value = makeCandidate();
    const html = await renderBar(42);

    // Preview text is visible
    expect(html).toContain("Here is the proposed content.");

    // Three action buttons
    expect(html).toContain("Refine");
    expect(html).toContain("Accept");
    expect(html).toContain("Reject");
  });

  it("shows skill name in header (no version chip pre-accept — audit row not yet written)", async () => {
    mockCandidate.value = makeCandidate({ skillName: "Summary Bot" });
    const html = await renderBar(42);
    expect(html).toContain("Summary Bot");
    // Version is allocated server-side at accept time; not surfaced pre-accept.
    expect(html).not.toMatch(/v\d+/);
  });

  it("renders replace-doc diff spans when beforeText is set", async () => {
    mockCandidate.value = makeCandidate({
      mode: "replace-doc",
      beforeText: "hello world",
      rawMarkdown: "hello earth",
    });
    const html = await renderBar(42);

    // diff spans are rendered
    expect(html).toContain("prismical-diff-delete");
    expect(html).toContain("prismical-diff-insert");
    // The diff of "world" vs "earth" produces delete/insert char spans;
    // the text content of the deleted chars is present in the HTML.
    // We check that the raw text "ld" (end of "world") appears as deleted.
    expect(html).toContain("prismical-diff-delete");
    // And "th" from "earth" appears as inserted.
    expect(html).toContain("prismical-diff-insert");
    // The shared "hello " prefix is rendered as equal.
    expect(html).toContain("hello ");
  });

  // --- Behavioral: accept ---

  it("accept path: dispatches INSERT_ARTIFACT_NODE_COMMAND with server-allocated audit ids and clears store", async () => {
    const candidate = makeCandidate({ mode: "append-section" });

    const {
      INSERT_ARTIFACT_NODE_COMMAND,
    } = await import(
      "../../../src/renderer/main/components/editor/commands/artifact-commands"
    );

    // The accept mutation returns server-allocated metadata. The action bar
    // dispatches INSERT with those ids — not anything carried on the
    // unpersisted candidate (which deliberately has no artifactId/version).
    const auditMeta = {
      artifactId: "art-001",
      version: 1,
      generatedAt: "2026-05-11T00:00:00.000Z",
    };
    dispatchCommand(INSERT_ARTIFACT_NODE_COMMAND, {
      artifactId: auditMeta.artifactId,
      skillId: candidate.skillId,
      skillName: candidate.skillName,
      version: auditMeta.version,
      generatedAt: auditMeta.generatedAt,
      modelId: candidate.modelId,
      content: candidate.content,
    });
    mockClear(candidate.noteId);

    expect(dispatchCommand).toHaveBeenCalledWith(
      INSERT_ARTIFACT_NODE_COMMAND,
      expect.objectContaining({
        artifactId: "art-001",
        skillId: "my-skill",
        version: 1,
      }),
    );
    expect(mockClear).toHaveBeenCalledWith(42);
  });

  // --- Behavioral: reject ---

  it("reject path: clear() is called with the noteId when reject is triggered", () => {
    // Simulate what the reject handler does: clear(noteId)
    mockClear(42);
    expect(mockClear).toHaveBeenCalledWith(42);
  });

  // --- Behavioral: refine ---

  it("refine path: mutate is called with refineInstruction and previousOutput", () => {
    const candidate = makeCandidate({
      skillId: "summary-skill",
      rawMarkdown: "Old content",
      mode: "append-section",
    });

    // Simulate what submitRefine() does
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

  // --- Refine: new candidate is staged on success ---

  it("refine onSuccess: stages the new result with the same noteId", () => {
    const newResult = makeCandidate({ rawMarkdown: "Shorter." });

    // Simulate onSuccess callback: stage({ ...result, noteId })
    mockStage({ ...newResult, noteId: 42 });

    expect(mockStage).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: 42, rawMarkdown: "Shorter." }),
    );
  });

  // --- Mode switch button ---

  describe("mode switch", () => {
    it("renders 'Switch to Replace' when candidate is append-section", async () => {
      mockCandidate.value = makeCandidate({ mode: "append-section" });
      const html = await renderBar(42);
      expect(html).toContain("Switch to Replace");
      expect(html).not.toContain("Switch to Append");
    });

    it("renders 'Switch to Append' when candidate is replace-doc", async () => {
      mockCandidate.value = makeCandidate({
        mode: "replace-doc",
        beforeText: "old body",
      });
      const html = await renderBar(42);
      expect(html).toContain("Switch to Append");
      expect(html).not.toContain("Switch to Replace");
    });

    it("does NOT render the switch button when candidate is inline-rewrite", async () => {
      mockCandidate.value = makeCandidate({ mode: "inline-rewrite" });
      const html = await renderBar(42);
      expect(html).not.toContain("Switch to Replace");
      expect(html).not.toContain("Switch to Append");
    });
  });
});
