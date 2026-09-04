import {
  buildEditorExtensions,
  ArtifactNode,
  ARTIFACT_NODE_NAME,
  ArtifactInlineNode,
  ARTIFACT_INLINE_NODE_NAME,
} from "@prismical/editor-schema";
import { Collaboration } from "@tiptap/extension-collaboration";
import { Placeholder } from "@tiptap/extensions";
import type { Extensions } from "@tiptap/core";
import type * as Y from "yjs";
import { artifactBlockCommands } from "./artifact-node-commands";
import { artifactInlineCommands } from "./artifact-inline-node-commands";
import { SkillDiffPlugin } from "./diff/diff-plugin";
import { SkillDiffEditorLock } from "./diff/skill-diff-editor-lock";

// The shared schema ships the artifact nodes as SCHEMA-ONLY (so the collaboration service stays in
// parity). Attach the renderer-coupled insert commands via `.extend()` — that adds commands
// WITHOUT changing the schema specs, so getSchema() parity is preserved. Built once.
const WebArtifactNode = ArtifactNode.extend(artifactBlockCommands);
const WebArtifactInlineNode = ArtifactInlineNode.extend(artifactInlineCommands);

// The web editor's extension set: the SHARED schema (parity with the collaboration service's
// nodeFromJSON) with StarterKit history off (Yjs owns undo/redo), the artifact node upgraded with
// its insert command, plus Collaboration bound to the provider's Y.Doc under the 'default' field,
// and the skill-diff overlay (decoration plugin + per-note editor lock). The diff extensions add no
// schema nodes/marks, so parity is unaffected. `noteId` scopes the editor lock to this note's
// staged candidate.
export function buildWebEditorExtensions(
  doc: Y.Doc,
  noteId: string,
  placeholder: string,
): Extensions {
  const base = buildEditorExtensions({ undoRedo: false }).map((ext) => {
    if (ext.name === ARTIFACT_NODE_NAME) return WebArtifactNode;
    if (ext.name === ARTIFACT_INLINE_NODE_NAME) return WebArtifactInlineNode;
    return ext;
  });
  return [
    ...base,
    Collaboration.configure({ document: doc, field: "default" }),
    Placeholder.configure({ placeholder }),
    SkillDiffPlugin,
    SkillDiffEditorLock.configure({ noteId }),
  ];
}
