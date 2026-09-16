import type { Node as PMNode } from "@tiptap/pm/model";
import type { CommandProps } from "@tiptap/core";
import { ARTIFACT_NODE_NAME } from "@prismical/editor-schema";

/** Replace only the editor's sole default paragraph; all other structure is authored content. */
export function artifactInsertionRange(doc: PMNode): { from: number; to: number } {
  const first = doc.firstChild;
  const defaultParagraph = first?.type.name === "paragraph" && first.eq(first.type.create());
  return {
    from: doc.childCount === 1 && defaultParagraph ? 0 : doc.content.size,
    to: doc.content.size,
  };
}

// Metadata mirrors the cloud `artifact` row plus the human-readable skill name (so the card chrome
// renders without a separate skills lookup). `generatedAt` is an ISO 8601 string.
export interface ArtifactNodeMetadata {
  artifactId: string;
  skillId: string;
  skillName: string;
  version: number;
  generatedAt: string; // ISO 8601
  modelId: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    artifactBlock: {
      // The regen-in-place invariant is enforced by the command: if an existing artifact with the
      // same skillId is in the doc, its content + metadata are replaced rather than a sibling
      // appended — so re-running the same skill never duplicates blocks.
      insertArtifactBlock: (
        payload: ArtifactNodeMetadata & { content: object[] },
      ) => ReturnType;
    };
  }
}

/**
 * The renderer-coupled `addCommands` half of ArtifactNode, attached to the
 * shared schema-only node via `.extend()` with a guarded `nodeType` lookup.
 */
export const artifactBlockCommands = {
  addCommands() {
    return {
      insertArtifactBlock:
        (payload: ArtifactNodeMetadata & { content: object[] }) =>
        ({ commands, state, tr, dispatch }: CommandProps) => {
          // Regen invariant: re-running an append-section skill walks the doc for an existing
          // artifact block with matching skillId and replaces its children + bumps metadata in
          // place, keeping node identity stable (cursor/scroll) and avoiding duplicates.
          let existingPos: number | null = null;
          state.doc.descendants((child, pos) => {
            if (existingPos !== null) return false;
            if (
              child.type.name === ARTIFACT_NODE_NAME &&
              child.attrs.skillId === payload.skillId
            ) {
              existingPos = pos;
              return false;
            }
            return true;
          });

          const nodeType = state.schema.nodes[ARTIFACT_NODE_NAME];
          if (!nodeType) return false;

          let newNode: ReturnType<(typeof nodeType)["create"]>;
          try {
            newNode = nodeType.create(
              {
                artifactId: payload.artifactId,
                skillId: payload.skillId,
                skillName: payload.skillName,
                version: payload.version,
                generatedAt: payload.generatedAt,
                modelId: payload.modelId,
              },
              payload.content.map((child) => state.schema.nodeFromJSON(child)),
            );
          } catch (err) {
            // Malformed payload (skill output didn't match the schema). Fail quietly rather than
            // throwing out of TipTap's command runner, which would crash the editor.
            console.warn("insertArtifactBlock: failed to materialize node from payload", err);
            return false;
          }

          if (existingPos !== null) {
            const existing = state.doc.nodeAt(existingPos);
            if (existing) {
              if (dispatch) {
                tr.replaceWith(existingPos, existingPos + existing.nodeSize, newNode);
              }
              return true;
            }
          }

          // Keep the trailing editing paragraph, without retaining the initial placeholder above it.
          return commands.insertContentAt(artifactInsertionRange(state.doc), newNode.toJSON());
        },
    };
  },
};
