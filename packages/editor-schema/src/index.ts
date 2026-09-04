import { StarterKit } from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { Emoji, gitHubEmojis } from '@tiptap/extension-emoji';
import { createLowlight } from 'lowlight';
import { getSchema, type Extensions } from '@tiptap/core';
import { ArtifactNode } from './nodes/artifact.js';
import { ArtifactInlineNode } from './nodes/artifact-inline.js';

export { ArtifactNode, ARTIFACT_NODE_NAME } from './nodes/artifact.js';
export { ArtifactInlineNode, ARTIFACT_INLINE_NODE_NAME } from './nodes/artifact-inline.js';

const emptyLowlight = createLowlight();

// Headless, render-free editor extension set. Every environment uses the same
// node set so schema.nodeFromJSON can deserialize shared Y.Docs consistently.
export function buildEditorExtensions(opts?: { undoRedo?: boolean }): Extensions {
  return [
    // `undoRedo` is a plugin, not a node/mark, so toggling it does NOT change the
    // ProseMirror schema — collaboration clients disable it because Yjs owns history.
    StarterKit.configure({ codeBlock: false, undoRedo: opts?.undoRedo === false ? false : undefined }),
    CodeBlockLowlight.configure({ lowlight: emptyLowlight }),
    TaskList,
    TaskItem.configure({ nested: true }),
    ArtifactNode,
    ArtifactInlineNode,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Emoji.configure({ emojis: gitHubEmojis, enableEmoticons: false }),
  ];
}

// Cached ProseMirror schema built from the extension set above.
let cachedSchema: ReturnType<typeof getSchema> | null = null;

export function getEditorSchema(): ReturnType<typeof getSchema> {
  if (!cachedSchema) {
    cachedSchema = getSchema(buildEditorExtensions());
  }
  return cachedSchema;
}
