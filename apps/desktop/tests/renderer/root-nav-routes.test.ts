import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("@/trpc/react", () => ({
  api: {
    Provider: ({ children }: { children: unknown }) => children,
  },
  trpcClient: {},
}));

vi.mock("@/components/transcription-download-widget", () => ({
  TranscriptionDownloadWidget: () => null,
}));

vi.mock("@/components/llm-setup-prompt-toast", () => ({
  LLMSetupPromptToast: () => null,
}));

vi.mock("../../src/renderer/main/lib/posthog", () => ({
  usePostHog: () => undefined,
}));

const routeTreePath = resolve(
  import.meta.dirname,
  "../../src/renderer/main/routeTree.gen.ts",
);

function readRouteTreeSource() {
  return readFileSync(routeTreePath, "utf8");
}

async function createTestRouter(initialEntry: string) {
  vi.stubGlobal("window", {
    electronAPI: { platform: "darwin" },
  });

  const { createMemoryHistory, createRouter } = await import(
    "@tanstack/react-router"
  );
  const { routeTree } = await import("../../src/renderer/main/routeTree.gen");

  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

function expectBeforeLoadRedirect(
  router: Awaited<ReturnType<typeof createTestRouter>>,
  pathname: string,
  to: string,
) {
  const redirectingMatch = router.matchRoutes(pathname).at(-1);
  const redirectingRoute = redirectingMatch
    ? router.routesById[redirectingMatch.routeId]
    : undefined;

  expect(() => redirectingRoute?.options.beforeLoad?.({} as never)).toThrow(
    expect.objectContaining({ options: expect.objectContaining({ to }) }),
  );
}

describe("root app navigation routes", () => {
  it("registers primary app surfaces at the root", () => {
    const source = readRouteTreeSource();

    expect(source).toContain("'/home':");
    expect(source).toContain("'/notes':");
    expect(source).toContain("'/notes/$noteId':");
    expect(source).toContain("'/events':");
    expect(source).toContain("'/tags':");
  });

  it("keeps settings-only screens under settings", () => {
    const source = readRouteTreeSource();

    expect(source).toContain("'/settings/preferences':");
    expect(source).toContain("'/settings/ai-models':");
    expect(source).toContain("'/settings/shortcuts':");
    expect(source).toContain("'/settings/vocabulary':");
    expect(source).toContain("'/settings/advanced':");
    expect(source).toContain("'/settings/about':");
  });

  it("does not expose old settings-prefixed app surfaces", () => {
    const source = readRouteTreeSource();

    expect(source).not.toContain("'/settings/home':");
    expect(source).not.toContain("'/settings/notes':");
    expect(source).not.toContain("'/settings/notes/$noteId':");
    expect(source).not.toContain("'/settings/events':");
    expect(source).not.toContain("'/projects':");
    expect(source).not.toContain("'/settings/projects':");
    expect(source).not.toContain("'/settings/tags':");
  });

  it("redirects root and settings indexes to their canonical routes", async () => {
    const router = await createTestRouter("/home");

    expectBeforeLoadRedirect(router, "/", "/home");
    expectBeforeLoadRedirect(router, "/settings", "/settings/preferences");
  });

  it("matches raw note deep links used by main-process navigation", async () => {
    const router = await createTestRouter("/home");
    const matches = router.matchRoutes("/notes/42", {
      autoRecord: true,
    });

    expect(
      matches.map((match) => router.routesById[match.routeId]?.fullPath),
    ).toContain("/notes/$noteId");
    expect(matches.at(-1)?.params).toMatchObject({ noteId: "42" });
  });
});
