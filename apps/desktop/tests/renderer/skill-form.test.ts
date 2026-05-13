import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@/db/schema";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const createMutate = vi.hoisted(() => vi.fn());
const updateMutate = vi.hoisted(() => vi.fn());
const invalidate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/trpc/react", () => ({
  api: {
    skills: {
      create: {
        useMutation: vi.fn(() => ({
          mutate: createMutate,
          isPending: false,
        })),
      },
      update: {
        useMutation: vi.fn(() => ({
          mutate: updateMutate,
          isPending: false,
        })),
      },
    },
    useUtils: () => ({
      skills: {
        list: { invalidate },
      },
    }),
  },
}));

// ---------------------------------------------------------------------------
// Skill factory
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    slug: "test-skill",
    name: "My Skill",
    description: "A description",
    iconUrl: null,
    body: "You are a helpful assistant.",
    config: { editingOptions: "append-section", surface: ["dock"] },
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

async function renderForm(props: { mode: "new" | "edit"; existing?: Skill }) {
  const { SkillForm } = await import(
    "../../src/renderer/main/pages/skills/components/skill-form"
  );
  return renderToStaticMarkup(
    React.createElement(SkillForm, props),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("renders name and body inputs in new mode", async () => {
    const html = await renderForm({ mode: "new" });
    expect(html).toContain('id="name"');
    expect(html).toContain('id="body"');
  });

  it("does NOT expose a slug input — slug auto-derives from name", async () => {
    const html = await renderForm({ mode: "new" });
    expect(html).not.toContain('id="slug"');
  });

  it("renders Create button in new mode", async () => {
    const html = await renderForm({ mode: "new" });
    expect(html).toContain(">Create<");
  });

  it("renders Save button in edit mode", async () => {
    const existing = makeSkill();
    const html = await renderForm({ mode: "edit", existing });
    expect(html).toContain(">Save<");
  });

  it("populates existing skill values in edit mode", async () => {
    const existing = makeSkill({ name: "Populated Skill" });
    const html = await renderForm({ mode: "edit", existing });
    expect(html).toContain("Populated Skill");
  });

  it("does not render slug field in edit mode", async () => {
    const existing = makeSkill();
    const html = await renderForm({ mode: "edit", existing });
    expect(html).not.toContain('id="slug"');
  });

  it("shows read-only banner for system skills", async () => {
    const systemSkill = makeSkill({ system: true });
    const html = await renderForm({ mode: "edit", existing: systemSkill });
    expect(html).toContain("system skill");
    expect(html).toContain("read-only");
  });

  it("disables submit button for system skills", async () => {
    const systemSkill = makeSkill({ system: true });
    const html = await renderForm({ mode: "edit", existing: systemSkill });
    // Button has disabled attribute when isReadOnly
    expect(html).toContain("disabled");
  });

  it("renders Dock and Inline surface checkboxes", async () => {
    const html = await renderForm({ mode: "new" });
    expect(html).toContain("Dock");
    expect(html).toContain("Inline (highlight popover)");
  });

  it("renders mode radio group options", async () => {
    const html = await renderForm({ mode: "new" });
    expect(html).toContain("Append section");
    expect(html).toContain("Replace document");
    expect(html).toContain("Inline rewrite");
  });
});
