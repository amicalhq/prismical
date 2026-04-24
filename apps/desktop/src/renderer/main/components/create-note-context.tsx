import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { api } from "@/trpc/react";

type CreateNoteContextValue = {
  createNote: () => void;
  isPending: boolean;
  shortcutDisplay: string;
};

const CreateNoteContext = createContext<CreateNoteContextValue | null>(null);

export function CreateNoteProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const utils = api.useUtils();
  const preferencesQuery = api.settings.getPreferences.useQuery();
  const isMac =
    typeof window !== "undefined" && window.electronAPI?.platform === "darwin";

  const mutation = api.notes.createNote.useMutation({
    onSuccess: async (newNote) => {
      utils.notes.getNotes.invalidate();
      let autoRecord = preferencesQuery.data?.autoDictateOnNewNote;
      if (autoRecord === undefined) {
        try {
          const prefs = await utils.settings.getPreferences.fetch();
          autoRecord = prefs?.autoDictateOnNewNote;
        } catch {
          autoRecord = false;
        }
      }
      navigate({
        to: "/settings/notes/$noteId",
        params: { noteId: String(newNote.id) },
        search: autoRecord ? { autoRecord: true } : {},
      });
    },
    onError: (error) => {
      toast.error(
        t("settings.notes.toast.createFailed", { message: error.message }),
      );
    },
  });

  const createNote = useCallback(() => {
    if (mutation.isPending) return;
    const dateStr = new Date().toLocaleDateString(i18n.language, {
      day: "numeric",
      month: "short",
    });
    mutation.mutate({
      title: t("settings.notes.defaultTitleWithDate", { date: dateStr }),
    });
  }, [mutation, i18n.language, t]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "n" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        createNote();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [createNote]);

  const value = useMemo<CreateNoteContextValue>(
    () => ({
      createNote,
      isPending: mutation.isPending,
      shortcutDisplay: isMac ? "⌘ N" : "Ctrl+N",
    }),
    [createNote, mutation.isPending, isMac],
  );

  return (
    <CreateNoteContext.Provider value={value}>
      {children}
    </CreateNoteContext.Provider>
  );
}

export function useCreateNoteAction(): CreateNoteContextValue {
  const ctx = useContext(CreateNoteContext);
  if (!ctx) {
    throw new Error("useCreateNoteAction must be used within CreateNoteProvider");
  }
  return ctx;
}
