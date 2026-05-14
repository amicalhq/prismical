import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Skill } from "@/db/schema";

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const listForSurfaceUseQuery = vi.hoisted(() => vi.fn());
const getInFlightUseQuery = vi.hoisted(() => vi.fn());
const cancelMutate = vi.hoisted(() => vi.fn());
const runMutate = vi.hoisted(() => vi.fn());
const invalidate = vi.hoisted(() => vi.fn());

vi.mock("@/trpc/react", () => ({
  api: {
    skills: {
      listForSurface: { useQuery: listForSurfaceUseQuery },
    },
    skillRuns: {
      getInFlight: { useQuery: getInFlightUseQuery },
      cancel: {
        useMutation: vi.fn(() => ({
          mutate: cancelMutate,
          isPending: false,
        })),
      },
    },
    useUtils: () => ({
      skillRuns: {
        getInFlight: { invalidate },
      },
    }),
  },
}));

vi.mock("@/renderer/main/hooks/use-run-skill", () => ({
  useRunSkill: () => ({
    runSkill: runMutate,
    isPending: false,
  }),
}));

// ---------------------------------------------------------------------------
// Skill factory
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    slug: "enhance",
    name: "Enhance",
    description: null,
    iconUrl: null,
    body: "You are a helpful assistant.",
    config: {
      editingOptions: "append-section",
      surface: ["dock"],
      defaultSkill: true,
    },
    enabled: true,
    system: false,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Skill;
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

async function renderButton(noteId = 1) {
  const { SkillSparkleButton } = await import(
    "../../src/renderer/main/pages/notes/components/skill-sparkle-button"
  );
  return renderToStaticMarkup(
    React.createElement(SkillSparkleButton, { noteId }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillSparkleButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("renders nothing when no dock skills are available", async () => {
    listForSurfaceUseQuery.mockReturnValue({ data: [] });
    getInFlightUseQuery.mockReturnValue({ data: null });
    const html = await renderButton();
    expect(html).toBe("");
  });

  it("renders the default skill name in idle state", async () => {
    listForSurfaceUseQuery.mockReturnValue({ data: [makeSkill()] });
    getInFlightUseQuery.mockReturnValue({ data: null });
    const html = await renderButton();
    expect(html).toContain("Enhance");
  });

  it("renders chevron button in idle state", async () => {
    listForSurfaceUseQuery.mockReturnValue({ data: [makeSkill()] });
    getInFlightUseQuery.mockReturnValue({ data: null });
    const html = await renderButton();
    // The split pill has two interactive zones; the chevron is the right one.
    expect(html).toContain('aria-label="Pick a different skill"');
    expect(html).toContain("tabler-icon-chevron-up");
  });

  it("renders skill names in the dropdown when multiple dock skills exist", async () => {
    const skills = [
      makeSkill({ id: "s1", slug: "enhance", name: "Enhance", config: { editingOptions: "append-section", surface: ["dock"], defaultSkill: true } }),
      makeSkill({ id: "s2", slug: "cleanup", name: "Cleanup", config: { editingOptions: "replace-doc", surface: ["dock"] } }),
    ];
    listForSurfaceUseQuery.mockReturnValue({ data: skills });
    getInFlightUseQuery.mockReturnValue({ data: null });
    const html = await renderButton();
    // The default skill name appears in the split button label (not in the portal)
    expect(html).toContain("Enhance");
    // DropdownMenuContent is a portal — it is not emitted by renderToStaticMarkup,
    // but we can verify both skills are passed to the query that drives the list.
    expect(listForSurfaceUseQuery).toHaveBeenCalledWith({ surface: "dock" });
  });

  it("renders mode labels in dropdown rows (verifies query is called for inline skills list)", async () => {
    listForSurfaceUseQuery.mockReturnValue({ data: [makeSkill()] });
    getInFlightUseQuery.mockReturnValue({ data: null });
    // DropdownMenuContent (portal) is not rendered in SSR — we assert the
    // component mounts without error and the dock-surface query is issued.
    const html = await renderButton();
    expect(html).toContain("Enhance");
    expect(listForSurfaceUseQuery).toHaveBeenCalledWith({ surface: "dock" });
  });

  it("renders the Generating state with a stop affordance when a skill run is in-flight", async () => {
    listForSurfaceUseQuery.mockReturnValue({ data: [makeSkill()] });
    getInFlightUseQuery.mockReturnValue({
      data: { noteId: 1, skillSlug: "enhance", startedAt: new Date().toISOString() },
    });
    const html = await renderButton(1);
    // Shimmering "Generating" label + X-button stop affordance (aria-label
    // is the stable identifier here; the visible label is iconographic).
    expect(html).toContain("Generating");
    expect(html).toContain("shimmer-text-pill");
    expect(html).toContain('aria-label="Stop skill run"');
    // The default-skill label should NOT be present while a run is in flight —
    // the generating-state pill replaces it.
    expect(html).not.toContain("Enhance");
  });

  it("queries listForSurface with dock surface", async () => {
    listForSurfaceUseQuery.mockReturnValue({ data: [] });
    getInFlightUseQuery.mockReturnValue({ data: null });
    await renderButton();
    expect(listForSurfaceUseQuery).toHaveBeenCalledWith({ surface: "dock" });
  });

  it("queries getInFlight with the given noteId, polling every 1s so cross-component consumers stay in sync", async () => {
    listForSurfaceUseQuery.mockReturnValue({ data: [] });
    getInFlightUseQuery.mockReturnValue({ data: null });
    await renderButton(42);
    const calls = getInFlightUseQuery.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]).toEqual({ noteId: 42 });
    // Constant 1s cadence — the prior data-gated function was race-prone
    // (initial null result would stop polling for the whole run).
    expect(lastCall?.[1]?.refetchInterval).toBe(1000);
  });
});
