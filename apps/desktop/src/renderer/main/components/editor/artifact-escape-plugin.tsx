import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isRootNode,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import {
  ArtifactNode,
  $isArtifactNode,
} from "./nodes/artifact-node";

function $ensureArtifactTrailingParagraph(node: ArtifactNode): void {
  const parent = node.getParent();
  if (!parent || !$isRootNode(parent)) return;
  if (node.getNextSibling() !== null) return;
  node.insertAfter($createParagraphNode());
}

function $findArtifactAncestor(node: LexicalNode): ArtifactNode | null {
  let cur: LexicalNode | null = node;
  while (cur) {
    if ($isArtifactNode(cur)) return cur;
    cur = cur.getParent();
  }
  return null;
}

function $isLastDescendantPosition(
  artifact: ArtifactNode,
  block: LexicalNode,
): boolean {
  // We're at the bottom edge if walking up from `block` to `artifact` never
  // encounters a node that has a next sibling — i.e. block is on the artifact's
  // last-child chain.
  let cur: LexicalNode | null = block;
  while (cur && cur !== artifact) {
    if (cur.getNextSibling() !== null) return false;
    cur = cur.getParent();
  }
  return cur === artifact;
}

function $isFirstDescendantPosition(
  artifact: ArtifactNode,
  block: LexicalNode,
): boolean {
  // Top-edge mirror of $isLastDescendantPosition: walking up from `block` to
  // `artifact` must never cross a node with a previous sibling — i.e. block is
  // on the artifact's first-child chain.
  let cur: LexicalNode | null = block;
  while (cur && cur !== artifact) {
    if (cur.getPreviousSibling() !== null) return false;
    cur = cur.getParent();
  }
  return cur === artifact;
}

export function $tryEscapeArtifactDown(requireEmpty = true): boolean {
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;

  const anchorNode = sel.anchor.getNode();
  const artifact = $findArtifactAncestor(anchorNode);
  if (!artifact) return false;

  const leafBlock = $isElementNode(anchorNode)
    ? anchorNode
    : anchorNode.getParent();
  if (!leafBlock || !$isElementNode(leafBlock)) return false;

  if (!$isLastDescendantPosition(artifact, leafBlock)) return false;

  // Caret must be at the end of the leaf — otherwise we'd swallow mid-line keys.
  if (sel.anchor.offset !== anchorNode.getTextContentSize()) return false;

  // Enter only escapes from an empty leaf — otherwise we'd block normal
  // newline insertion at the end of a non-empty paragraph.
  if (requireEmpty && leafBlock.getTextContentSize() !== 0) return false;

  let next = artifact.getNextSibling();
  if (next === null) {
    // Defensive: Task 1's transform should have created this; if it hasn't run
    // yet, do it now so we have somewhere to land.
    next = $createParagraphNode();
    artifact.insertAfter(next);
  }

  if (!$isElementNode(next)) {
    // Top-level DecoratorNodes (none today, but possible — e.g. images/embeds)
    // can't accept selectStart; bail so the default Enter/ArrowDown handling
    // runs instead of trapping the caret.
    return false;
  }
  next.selectStart();
  return true;
}

export function $tryEscapeArtifactUp(requireEmpty = false): boolean {
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;

  const anchorNode = sel.anchor.getNode();
  const artifact = $findArtifactAncestor(anchorNode);
  if (!artifact) return false;

  const leafBlock = $isElementNode(anchorNode)
    ? anchorNode
    : anchorNode.getParent();
  if (!leafBlock || !$isElementNode(leafBlock)) return false;

  if (!$isFirstDescendantPosition(artifact, leafBlock)) return false;

  // Caret must be at the start of the leaf — otherwise we'd swallow mid-line keys.
  if (sel.anchor.offset !== 0) return false;

  // Backspace/Arrow-Up only escape from an empty leaf when callers ask for it
  // (the wired commands pass false — Backspace at the top edge is always an
  // escape, never a deletion).
  if (requireEmpty && leafBlock.getTextContentSize() !== 0) return false;

  let prev = artifact.getPreviousSibling();
  if (prev === null) {
    // Symmetric to the downward fallback: ensure there is a place to land
    // above the artifact, even if the user's doc started with the artifact.
    prev = $createParagraphNode();
    artifact.insertBefore(prev);
  }

  if (!$isElementNode(prev)) {
    // Top-level DecoratorNodes (none today, but possible — e.g. images/embeds)
    // can't accept selectEnd; bail so the default Backspace/ArrowUp handling
    // runs instead of trapping the caret.
    return false;
  }
  prev.selectEnd();
  return true;
}

export function registerArtifactEscape(editor: LexicalEditor): () => void {
  const unregisterTransform = editor.registerNodeTransform(
    ArtifactNode,
    $ensureArtifactTrailingParagraph,
  );

  // KEY_ENTER_COMMAND's payload is `KeyboardEvent | null` — Lexical allows
  // programmatic dispatch without an event, so the optional chaining here is
  // intentional (the arrow/backspace commands below carry non-null payloads).
  const unregisterEnter = editor.registerCommand(
    KEY_ENTER_COMMAND,
    (event) => {
      if (event?.shiftKey) return false; // Shift-Enter is line-break, leave it.
      if (!$tryEscapeArtifactDown(/* requireEmpty */ true)) return false;
      event?.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_LOW,
  );

  const unregisterArrowDown = editor.registerCommand(
    KEY_ARROW_DOWN_COMMAND,
    (event) => {
      if (event.shiftKey) return false; // Don't break shift-select extension.
      if (!$tryEscapeArtifactDown(/* requireEmpty */ false)) return false;
      event.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_LOW,
  );

  const unregisterArrowUp = editor.registerCommand(
    KEY_ARROW_UP_COMMAND,
    (event) => {
      if (event.shiftKey) return false;
      if (!$tryEscapeArtifactUp(false)) return false;
      event.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_LOW,
  );

  // No shiftKey check: browsers treat Shift-Backspace identically to Backspace,
  // and at the artifact's top edge we always want to escape rather than delete.
  const unregisterBackspace = editor.registerCommand(
    KEY_BACKSPACE_COMMAND,
    (event) => {
      if (!$tryEscapeArtifactUp(false)) return false;
      event.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_LOW,
  );

  return () => {
    unregisterBackspace();
    unregisterArrowUp();
    unregisterArrowDown();
    unregisterEnter();
    unregisterTransform();
  };
}

export function ArtifactEscapePlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerArtifactEscape(editor), [editor]);
  return null;
}
