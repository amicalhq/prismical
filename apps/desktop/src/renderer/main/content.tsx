import React, { useEffect } from "react";
import {
  RouterProvider,
  createRouter,
  createHashHistory,
} from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { requestOpenTranscription } from "./utils/transcription-request";

const hashHistory = createHashHistory();

// Create the router instance
const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  history: hashHistory,
});

// Register the router instance for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Root App component with routing
const App: React.FC = () => {
  // Listen for navigation events from the main process (e.g., overlays)
  useEffect(() => {
    const handleNavigate = (route: string) => {
      router.navigate({ to: route });
    };

    // Typed navigation to a note. The "open transcription" signal goes via
    // `requestOpenTranscription` (pending set + DOM event) so it works for
    // both same-note re-triggers (event picked up by an already-mounted
    // listener) and cross-note navigations (new wrapper drains the pending
    // set on mount, even if the event fires before its listener registers).
    const handleNavigateToNote = (payload: {
      noteId: number;
      openTranscription?: boolean;
    }) => {
      if (payload.openTranscription) {
        requestOpenTranscription(payload.noteId);
      }
      router.navigate({
        to: "/settings/notes/$noteId",
        params: { noteId: String(payload.noteId) },
      });
    };

    window.electronAPI?.on?.("navigate", handleNavigate);
    window.electronAPI?.on?.("navigate-to-note", handleNavigateToNote);

    return () => {
      window.electronAPI?.off?.("navigate", handleNavigate);
      window.electronAPI?.off?.("navigate-to-note", handleNavigateToNote);
    };
  }, []);

  return <RouterProvider router={router} />;
};

export default App;
