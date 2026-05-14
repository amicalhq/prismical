import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHorizontalRuleNode } from "@lexical/extension";
import {
  $createParagraphNode,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
} from "lexical";

const HR_PATTERN = /^(---|\*\*\*|___)$/;

// `MarkdownShortcutPlugin` only fires element transformers on Space; this
// adds the Enter trigger.
export function HorizontalRuleShortcutPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event?.shiftKey) {
          return false;
        }

        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const parentNode = anchorNode.getParent();
        if (!$isParagraphNode(parentNode)) {
          return false;
        }

        if (!HR_PATTERN.test(parentNode.getTextContent())) {
          return false;
        }

        event?.preventDefault();

        const hr = $createHorizontalRuleNode();
        const trailing = $createParagraphNode();
        parentNode.replace(hr);
        hr.insertAfter(trailing);
        trailing.selectStart();

        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}
