import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Selection } from "@tiptap/pm/state";

// Inline-level wrapper around AI-rewritten text. No version field — inline
// rewrites are one-shot (regen replaces children atomically, not versioned).
// No visible chrome — the hover chip is rendered via a CSS `::after`
// pseudo-element on the `.prismical-artifact-inline` class.
export interface ArtifactInlineNodeMetadata {
  artifactId: string;
  skillId: string;
  skillName: string;
}

export const ARTIFACT_INLINE_NODE_NAME = "artifact-inline" as const;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    artifactInline: {
      // Replaces the current selection with an `artifact-inline` wrapper
      // containing the supplied content. If the selection is already
      // inside an `artifact-inline` for the same skillId, replace that
      // wrapper in place instead of nesting.
      insertArtifactInline: (
        payload: ArtifactInlineNodeMetadata & { content: object[] },
      ) => ReturnType;
    };
  }
}

export const ArtifactInlineNode = Node.create({
  name: ARTIFACT_INLINE_NODE_NAME,

  inline: true,
  group: "inline",
  content: "inline*",
  defining: true,
  selectable: false,
  atom: false,

  addAttributes() {
    return {
      artifactId: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-artifact-id") ?? "",
        renderHTML: (attrs) => ({ "data-artifact-id": attrs.artifactId }),
      },
      skillId: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-skill-id") ?? "",
        renderHTML: (attrs) => ({ "data-skill-id": attrs.skillId }),
      },
      skillName: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-skill-name") ?? "",
        renderHTML: (attrs) => ({ "data-skill-name": attrs.skillName }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span.prismical-artifact-inline" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "prismical-artifact-inline",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      insertArtifactInline:
        (payload) =>
        ({ state, tr, dispatch }) => {
          const { $from, $to } = state.selection;
          const existing = findInlineAncestor(state.selection, payload.skillId);

          const childNodes = payload.content.map((child) =>
            state.schema.nodeFromJSON(child),
          );

          const newNode = state.schema.nodes[ARTIFACT_INLINE_NODE_NAME].create(
            {
              artifactId: payload.artifactId,
              skillId: payload.skillId,
              skillName: payload.skillName,
            },
            childNodes,
          );

          if (existing) {
            if (dispatch) {
              tr.replaceWith(
                existing.from,
                existing.from + existing.node.nodeSize,
                newNode,
              );
            }
            return true;
          }

          if (dispatch) {
            tr.replaceWith($from.pos, $to.pos, newNode);
          }
          return true;
        },
    };
  },
});

// Walk up from the selection's anchor and head, looking for the nearest
// `artifact-inline` ancestor whose `skillId` matches `skillId`. Returns
// the first match (anchor wins if both ancestors match different artifacts —
// extremely unlikely in practice).
function findInlineAncestor(
  selection: Selection,
  skillId: string,
): { node: PMNode; from: number } | null {
  for (const $pos of [selection.$anchor, selection.$head]) {
    for (let d = $pos.depth; d > 0; d--) {
      const node = $pos.node(d);
      if (
        node.type.name === ARTIFACT_INLINE_NODE_NAME &&
        node.attrs.skillId === skillId
      ) {
        return { node, from: $pos.before(d) };
      }
    }
  }
  return null;
}
