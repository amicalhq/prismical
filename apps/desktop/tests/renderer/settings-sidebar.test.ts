import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routerState = vi.hoisted(() => ({
  pathname: "/events",
}));

const notesGetNotesUseQuery = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const notesSearchNotesUseQuery = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useMutation = vi.hoisted(() =>
  vi.fn(() => ({
    isPending: false,
    mutate: vi.fn(),
  })),
);
const tagsListFavoritesUseQuery = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const tagsListRecentUseQuery = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const tagsListWithCountsUseQuery = vi.hoisted(() =>
  vi.fn(() => ({ data: [] })),
);

vi.mock("@tanstack/react-router", async () => {
  const React = await import("react");

  return {
    Link: (
      props: React.PropsWithChildren<{ activeProps?: unknown; to: string }>,
    ) => {
      const { children, to, ...anchorProps } = props;
      delete anchorProps.activeProps;
      return React.createElement("a", { href: to, ...anchorProps }, children);
    },
    useLocation: () => routerState,
    useNavigate: () => vi.fn(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string) => key,
  }),
}));

vi.mock("@/hooks/useFeatureFlag", () => ({
  useFeatureFlag: () => ({ enabled: false, payload: null }),
}));

vi.mock("@/components/nav-secondary", async () => {
  const React = await import("react");

  return {
    NavSecondary: () => React.createElement("div", null),
  };
});

vi.mock("@/trpc/react", () => ({
  api: {
    notes: {
      createNote: { useMutation },
      deleteNote: { useMutation },
      getNotes: { useQuery: notesGetNotesUseQuery },
      searchNotes: { useQuery: notesSearchNotesUseQuery },
      updateNoteOrganization: { useMutation },
    },
    tags: {
      listFavorites: { useQuery: tagsListFavoritesUseQuery },
      listRecent: { useQuery: tagsListRecentUseQuery },
      listWithCounts: { useQuery: tagsListWithCountsUseQuery },
    },
    useUtils: () => ({
      notes: {
        getNotes: { invalidate: vi.fn() },
      },
      tags: { invalidate: vi.fn() },
    }),
  },
}));

async function renderSidebar(pathname: string) {
  routerState.pathname = pathname;
  vi.stubGlobal("window", {
    electronAPI: { platform: "darwin" },
  });

  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { SettingsSidebar } = await import(
    "../../src/renderer/main/components/settings-sidebar"
  );

  return renderToStaticMarkup(
    React.createElement(
      SidebarProvider,
      null,
      React.createElement(SettingsSidebar),
    ),
  );
}

describe("SettingsSidebar route modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not load notes navigation groups on non-notes app routes", async () => {
    await renderSidebar("/events");

    expect(notesGetNotesUseQuery).toHaveBeenCalledWith(
      {
        limit: 500,
        sortBy: "updatedAt",
        sortOrder: "desc",
      },
      { enabled: false },
    );
    expect(tagsListFavoritesUseQuery).not.toHaveBeenCalled();
    expect(tagsListRecentUseQuery).not.toHaveBeenCalled();
    expect(tagsListWithCountsUseQuery).not.toHaveBeenCalled();
  });

  it("loads notes navigation groups on notes routes", async () => {
    await renderSidebar("/notes/42");

    expect(notesGetNotesUseQuery).toHaveBeenCalledWith(
      {
        limit: 500,
        sortBy: "updatedAt",
        sortOrder: "desc",
      },
      { enabled: true },
    );
    expect(tagsListFavoritesUseQuery).toHaveBeenCalled();
    expect(tagsListRecentUseQuery).toHaveBeenCalledWith({ limit: 5 });
    expect(tagsListWithCountsUseQuery).toHaveBeenCalledWith({
      sortBy: "createdAt",
    });
  });

  it("keeps tag navigation available on the tags route", async () => {
    await renderSidebar("/tags");

    expect(notesGetNotesUseQuery).toHaveBeenCalledWith(
      {
        limit: 500,
        sortBy: "updatedAt",
        sortOrder: "desc",
      },
      { enabled: true },
    );
    expect(tagsListFavoritesUseQuery).toHaveBeenCalled();
    expect(tagsListRecentUseQuery).toHaveBeenCalledWith({ limit: 5 });
    expect(tagsListWithCountsUseQuery).toHaveBeenCalledWith({
      sortBy: "createdAt",
    });
  });
});
