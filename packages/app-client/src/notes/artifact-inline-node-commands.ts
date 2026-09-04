import type { CommandProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { ResolvedPos } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { ARTIFACT_INLINE_NODE_NAME } from "@prismical/editor-schema";

// Metadata for the inline artifact wrapper. No version field — inline rewrites are one-shot
// (regen replaces the wrapper atomically); no generatedAt on the node — the audit row carries it.
export interface ArtifactInlineNodeMetadata {
  artifactId: string;
  skillId: string;
  skillName: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    artifactInline: {
      // Replaces [from,to] with an `artifact-inline` wrapper containing `content`.
      // The range is EXPLICIT — the accept path resolves it from Yjs relative anchors
      // at dispatch time, so it cannot depend on where the
      // user's cursor happens to be after clicking the dock bar.
      insertArtifactInline: (
        payload: ArtifactInlineNodeMetadata & {
          content: object[];
          from: number;
          to: number;
        },
      ) => ReturnType;
    };
  }
}

/**
 * The renderer-coupled `addCommands` half of the shared schema-only ArtifactInlineNode, attached
 * via `.extend()` with an explicit range for collaboration safety.
 */
export const artifactInlineCommands = {
  addCommands() {
    return {
      insertArtifactInline:
        (payload: ArtifactInlineNodeMetadata & { content: object[]; from: number; to: number }) =>
        ({ state, tr, dispatch }: CommandProps) => {
          const { from, to } = payload;
          if (from < 0 || to > state.doc.content.size || from >= to) return false;

          const nodeType = state.schema.nodes[ARTIFACT_INLINE_NODE_NAME];
          if (!nodeType) return false;

          let newNode: PMNode;
          try {
            newNode = nodeType.create(
              {
                artifactId: payload.artifactId,
                skillId: payload.skillId,
                skillName: payload.skillName,
              },
              payload.content.map((child) => state.schema.nodeFromJSON(child)),
            );
          } catch (err) {
            // Malformed payload — fail quietly rather than throwing out of TipTap's command
            // runner, which would crash the editor.
            console.warn("insertArtifactInline: failed to materialize node from payload", err);
            return false;
          }

          const $from = state.doc.resolve(from);
          const $to = state.doc.resolve(to);

          // Collapse the selection after the wrapper once replaced — the mapped-through selection
          // would otherwise still span content and immediately re-summon the inline popover.
          const collapseAfter = (replaceFrom: number) => {
            const end = Math.min(replaceFrom + newNode.nodeSize, tr.doc.content.size);
            tr.setSelection(TextSelection.near(tr.doc.resolve(end), 1));
          };

          // Regen-in-place: rewriting text inside an existing wrapper for the same skill replaces
          // that whole wrapper (never nests same-skill wrappers). Rarely reachable on web — the
          // popover won't open inside a wrapper — but a remote-shifted accept range can land here.
          // replaceWith can throw (ReplaceError) on a range the guards didn't anticipate — return
          // false instead of throwing out of the command runner (the caller has a clean failure
          // path; an exception here would strand the diff overlay).
          try {
            const existing = findInlineAncestor($from, $to, payload.skillId);
            if (existing) {
              if (dispatch) {
                tr.replaceWith(existing.from, existing.from + existing.node.nodeSize, newNode);
                collapseAfter(existing.from);
              }
              return true;
            }

            // The wrapper is inline-only: the range must sit inside ONE textblock. (The popover
            // already restricts selections to a single textblock; this guards stale/shifted ranges.)
            if (!$from.parent.inlineContent || !$from.sameParent($to)) return false;

            if (dispatch) {
              tr.replaceWith(from, to, newNode);
              collapseAfter(from);
            }
            return true;
          } catch (err) {
            console.warn("insertArtifactInline: replace failed", err);
            return false;
          }
        },
    };
  },
};

// Walk up from both range endpoints looking for the nearest `artifact-inline`
// ancestor with a matching skillId.
function findInlineAncestor(
  $from: ResolvedPos,
  $to: ResolvedPos,
  skillId: string,
): { node: PMNode; from: number } | null {
  for (const $pos of [$from, $to]) {
    for (let d = $pos.depth; d > 0; d--) {
      const node = $pos.node(d);
      if (node.type.name === ARTIFACT_INLINE_NODE_NAME && node.attrs.skillId === skillId) {
        return { node, from: $pos.before(d) };
      }
    }
  }
  return null;
}
