import { useEffect } from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, trpcClient } from "@/trpc/react";
import { TranscriptionDownloadWidget } from "@/components/transcription-download-widget";
import { LLMSetupPromptToast } from "@/components/llm-setup-prompt-toast";
import { usePostHog } from "../lib/posthog";

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

export const Route = createRootRoute({
  component: RootComponent,
});

// Inner component that uses hooks requiring provider context
function AppShell() {
  usePostHog(); // Initialize and sync telemetry

  // Warm the cache for global toolbar data so the first /notes visit
  // doesn't flash empty controls. Sync layers can invalidate these keys
  // later without a stale-time tradeoff.
  const utils = api.useUtils();
  useEffect(() => {
    void utils.folders.tree.prefetch();
    void utils.tags.listWithCounts.prefetch({ sortBy: "name" });
  }, [utils]);

  return (
    <>
      <Outlet />
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        <LLMSetupPromptToast />
        <TranscriptionDownloadWidget />
      </div>
      {process.env.NODE_ENV === "development" && (
        <TanStackRouterDevtools position="bottom-right" />
      )}
    </>
  );
}

function RootComponent() {
  return (
    <api.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AppShell />
      </QueryClientProvider>
    </api.Provider>
  );
}
