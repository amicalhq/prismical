import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@/db/schema";

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const skillsListUseQuery = vi.hoisted(() => vi.fn(() => ({ data: [], isLoading: false })));
const useMutation = vi.hoisted(() =>
  vi.fn(() => ({
    isPending: false,
    mutate: vi.fn(),
  })),
);
const invalidate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async () => {
  const React = await import("react");
  return {
    Link: (props: React.PropsWithChildren<{ to: string; [key: string]: unknown }>) => {
      const { children, to } = props;
      return React.createElement("a", { href: to }, children);
    },
    useNavigate: () => vi.fn(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string) => key,
  }),
}));

vi.mock("@/trpc/react", () => ({
  api: {
    skills: {
      list: { useQuery: skillsListUseQuery },
      setEnabled: { useMutation },
      delete: { useMutation },
      // The list page wires api.skills.import.useMutation for the Import
      // button. Mock to avoid TypeError in tests that don't exercise import
      // behavior.
      import: { useMutation },
    },
    useUtils: () => ({
      skills: {
        list: { invalidate },
      },
    }),
  },
}));

// ---------------------------------------------------------------------------
// Minimal Skill factory
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    slug: "test-skill",
    name: "Test Skill",
    description: null,
    iconUrl: null,
    body: "You are a test skill.",
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

async function renderPage() {
  const { SkillsListPage } = await import(
    "../../src/renderer/main/pages/skills/skills-list-page"
  );
  return renderToStaticMarkup(React.createElement(SkillsListPage));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillsListPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("renders the Installed section header", async () => {
    skillsListUseQuery.mockReturnValue({ data: [], isLoading: false });
    const html = await renderPage();
    expect(html).toContain("skills.page.installedSection");
  });

  it("renders empty state when no skills", async () => {
    skillsListUseQuery.mockReturnValue({ data: [], isLoading: false });
    const html = await renderPage();
    expect(html).toContain("skills.page.empty");
  });

  it("renders New Skill link to /skills/new", async () => {
    skillsListUseQuery.mockReturnValue({ data: [], isLoading: false });
    const html = await renderPage();
    expect(html).toContain('href="/skills/new"');
  });

  it("renders skill name for a user skill", async () => {
    const userSkill = makeSkill({ name: "My Custom Skill", system: false });
    skillsListUseQuery.mockReturnValue({ data: [userSkill], isLoading: false });
    const html = await renderPage();
    expect(html).toContain("My Custom Skill");
  });

  it("renders loading state when isLoading=true", async () => {
    skillsListUseQuery.mockReturnValue({ data: [], isLoading: true });
    const html = await renderPage();
    expect(html).toContain("common.loading");
  });

  it("queries skills.list on mount", async () => {
    skillsListUseQuery.mockReturnValue({ data: [], isLoading: false });
    await renderPage();
    expect(skillsListUseQuery).toHaveBeenCalled();
  });
});
