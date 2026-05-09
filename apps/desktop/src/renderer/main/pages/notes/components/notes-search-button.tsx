import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

const isMac = window.electronAPI.platform === "darwin";

/**
 * Search-shaped button that opens the global Cmd+K commander dialog.
 *
 * Implementation: dispatch a synthetic Cmd+K keydown so the existing
 * CommandSearchButton handler (registered on document) opens the dialog.
 * This avoids forking the commander or coupling the notes browser to its
 * internals.
 */
export function NotesSearchButton() {
  const { t } = useTranslation();
  const shortcut = isMac ? "⌘ K" : "Ctrl K";

  const open = () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
      }),
    );
  };

  return (
    <button
      type="button"
      onClick={open}
      className="flex h-9 w-72 shrink-0 items-center gap-2 rounded-lg bg-accent/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-accent/60 dark:bg-accent/30 dark:hover:bg-accent/50"
    >
      <Search className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate whitespace-nowrap text-left">
        {t("settings.notes.searchButtonLabel")}
      </span>
      <kbd className="shrink-0 rounded bg-accent/60 px-1.5 py-0.5 font-mono text-xs dark:bg-accent/40">
        {shortcut}
      </kbd>
    </button>
  );
}
