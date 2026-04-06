import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { ThemeProvider } from "@/components/theme-provider";
import { api, trpcClient } from "@/trpc/react";
import type { MeetingStartNotificationState } from "@/types/meeting-start-notifications";
import "@/styles/globals.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function NotificationWindow() {
  const initialStateQuery = api.notifications.getState.useQuery();
  const [liveState, setLiveState] =
    useState<MeetingStartNotificationState | null>(null);

  api.notifications.stateUpdates.useSubscription(undefined, {
    onData: (nextState: MeetingStartNotificationState) => {
      setLiveState(nextState);
    },
  });

  const state = liveState ?? initialStateQuery.data ?? null;
  const activeNotification = state?.activeNotification ?? null;

  const dismissMutation = api.notifications.dismiss.useMutation();
  const startNoteMutation = api.notifications.startNote.useMutation();

  const isBusy = dismissMutation.isPending || startNoteMutation.isPending;
  const label = useMemo(() => {
    if (!activeNotification) {
      return null;
    }

    return activeNotification.displayName.charAt(0).toUpperCase();
  }, [activeNotification]);

  if (!activeNotification) {
    return <main className="h-screen w-screen bg-transparent" />;
  }

  return (
    <ThemeProvider>
      <main className="flex min-h-screen items-start justify-end bg-transparent p-3">
        <section className="w-full max-w-[356px] overflow-hidden rounded-2xl bg-[#1c1c1e] text-white backdrop-blur-2xl">
          <div className="flex items-start gap-3 p-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-[13px] font-semibold text-emerald-400">
              {label}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
                  Prismical
                </p>
                {activeNotification.isTest ? (
                  <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white/30">
                    Test
                  </span>
                ) : null}
              </div>
              <h1 className="mt-1 text-[13px] font-medium leading-snug">
                {activeNotification.title}
              </h1>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <button
                type="button"
                onClick={() => dismissMutation.mutate()}
                disabled={isBusy}
                className="flex size-6 items-center justify-center rounded-md text-white/25 transition hover:bg-white/[0.06] hover:text-white/50 disabled:pointer-events-none disabled:opacity-50"
                aria-label="Dismiss"
              >
                <X className="size-3" />
              </button>
              <button
                type="button"
                onClick={() => startNoteMutation.mutate()}
                disabled={isBusy}
                className="flex items-center gap-1.5 rounded-lg border border-white/[0.12] px-2.5 py-1.5 text-[11px] font-medium text-white/75 transition hover:border-white/20 hover:bg-white/[0.06] hover:text-white disabled:pointer-events-none disabled:opacity-50"
              >
                {startNoteMutation.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : null}
                Start note
              </button>
            </div>
          </div>
        </section>
      </main>
    </ThemeProvider>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <api.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <NotificationWindow />
      </QueryClientProvider>
    </api.Provider>,
  );
}
