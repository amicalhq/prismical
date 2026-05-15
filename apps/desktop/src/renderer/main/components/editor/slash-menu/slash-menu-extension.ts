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

const POPOVER_ESTIMATED_HEIGHT = 360; // ~10 items × ~32px + padding
const POPOVER_ESTIMATED_WIDTH = 240;
const VIEWPORT_MARGIN = 8;

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

  // Prefer below the caret; flip above if no room.
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  let top = rect.bottom + 6;
  if (top + POPOVER_ESTIMATED_HEIGHT > viewportHeight - VIEWPORT_MARGIN) {
    const flippedTop = rect.top - POPOVER_ESTIMATED_HEIGHT - 6;
    // If flipping up doesn't fit either, clamp into viewport.
    top = Math.max(VIEWPORT_MARGIN, flippedTop);
  }
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, rect.left),
    viewportWidth - POPOVER_ESTIMATED_WIDTH - VIEWPORT_MARGIN,
  );

  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

export const SlashMenuExtension = Extension.create({
  name: "prismicalSlashMenu",

  addProseMirrorPlugins() {
    let reactRenderer: ReactRenderer<SlashMenuPopoverHandle> | null = null;
    let popupEl: HTMLDivElement | null = null;

    return [
      Suggestion<SlashMenuItem, SlashMenuItem>({
        editor: this.editor,
        pluginKey: SlashMenuPluginKey,
        char: "/",
        startOfLine: false,
        // Only fire inside a paragraph, only when the trigger `/` is at the
        // start of the textblock (optionally preceded by a single space).
        // Prevents popover-spam mid-sentence and inside non-text blocks.
        // Also reject when inside table cells (nested tables aren't supported)
        // or inside artifact wrappers (they have their own surfaces).
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          const parent = $from.parent;
          if (parent.type.name !== "paragraph") return false;
          for (let d = $from.depth - 1; d > 0; d--) {
            const ancestor = $from.node(d).type.name;
            if (
              ancestor === "tableCell" ||
              ancestor === "tableHeader" ||
              ancestor === "artifact"
            ) {
              return false;
            }
          }
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
