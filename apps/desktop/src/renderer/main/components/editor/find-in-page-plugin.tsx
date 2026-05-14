import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";

interface Props {
  editor: Editor | null;
}

export function FindInPagePlugin({ editor }: Props): React.ReactNode {
  const [query, setQuery] = useState<string | null>(null);

  useEffect(() => {
    if (!editor) return;
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        const input = window.prompt("Find in note", query ?? "");
        if (input == null) return;
        if (!input) {
          window.electronAPI.findInPage.stop();
          setQuery(null);
          return;
        }
        setQuery(input);
        window.electronAPI.findInPage.start(input, {
          forward: true,
          findNext: false,
        });
      } else if (meta && (e.key === "g" || e.key === "G")) {
        if (!query) return;
        e.preventDefault();
        window.electronAPI.findInPage.start(query, {
          forward: !e.shiftKey,
          findNext: true,
        });
      } else if (e.key === "Escape" && query) {
        window.electronAPI.findInPage.stop();
        setQuery(null);
      }
    }
    const root = editor.view.dom;
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [editor, query]);

  return null;
}
