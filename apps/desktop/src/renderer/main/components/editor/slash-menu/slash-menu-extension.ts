import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import {
  filterSlashItems,
  SlashMenuItem,
} from "./slash-menu-items";
import {
  SlashMenuPopover,
  SlashMenuPopoverHandle,
} from "./slash-menu-popover";

export const SlashMenuPluginKey = new PluginKey("prismical-slash-menu");

function positionPopup(
  el: HTMLDivElement,
  clientRect: (() => DOMRect | null) | null | undefined,
): void {
  const rect = clientRect?.();
  if (!rect) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.style.position = "fixed";
  el.style.top = `${rect.bottom + 6}px`;
  el.style.left = `${rect.left}px`;
}

export const SlashMenuExtension = Extension.create({
  name: "prismicalSlashMenu",

  addProseMirrorPlugins() {
    let reactRenderer: ReactRenderer<SlashMenuPopoverHandle> | null = null;
    let popupEl: HTMLDivElement | null = null;

    return [
      Suggestion<SlashMenuItem>({
        editor: this.editor,
        pluginKey: SlashMenuPluginKey,
        char: "/",
        startOfLine: false,
        // Only fire inside a paragraph, only when the trigger `/` is at the
        // start of the textblock (optionally preceded by a single space).
        // Prevents popover-spam mid-sentence and inside non-text blocks.
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          const parent = $from.parent;
          if (parent.type.name !== "paragraph") return false;
          const before = parent.textContent.slice(0, $from.parentOffset);
          return before === "" || before === " ";
        },
        items: ({ query }) => filterSlashItems(query).slice(0, 10),
        command: ({ editor, range, props }) => {
          props.run(editor, range);
        },
        render: () => ({
          onStart: (props) => {
            popupEl = document.createElement("div");
            popupEl.style.position = "fixed";
            document.body.appendChild(popupEl);
            reactRenderer = new ReactRenderer(SlashMenuPopover, {
              editor: props.editor,
              props: {
                items: props.items,
                command: (item: SlashMenuItem) => props.command(item),
              },
            });
            popupEl.appendChild(reactRenderer.element);
            positionPopup(popupEl, props.clientRect);
          },
          onUpdate: (props) => {
            reactRenderer?.updateProps({
              items: props.items,
              command: (item: SlashMenuItem) => props.command(item),
            });
            if (popupEl) positionPopup(popupEl, props.clientRect);
          },
          onKeyDown: (props) => {
            if (props.event.key === "Escape") {
              return true;
            }
            return reactRenderer?.ref?.onKeyDown({ event: props.event }) ?? false;
          },
          onExit: () => {
            reactRenderer?.destroy();
            popupEl?.remove();
            reactRenderer = null;
            popupEl = null;
          },
        }),
      }),
    ];
  },
});
