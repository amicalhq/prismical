import { Node, mergeAttributes } from "@tiptap/core";

// Metadata schema mirrors the `artifacts` row plus the human-readable
// skill name (so the chrome can render without a separate skills lookup).
// `generatedAt` is an ISO 8601 string — JSON-stable; React renders it via
// `new Date(...).toLocaleString()` at display time.
export interface ArtifactNodeMetadata {
  artifactId: string;
  skillId: string;
  skillName: string;
  version: number;
  generatedAt: string; // ISO 8601
  modelId: string;
}

export const ARTIFACT_NODE_NAME = "artifact" as const;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    artifactBlock: {
      // The regen-in-place invariant is enforced by the command: if an
      // existing artifact with the same skillId is in the doc, its content
      // and metadata are replaced rather than a sibling block appended.
      insertArtifactBlock: (
        payload: ArtifactNodeMetadata & { content: object[] },
      ) => ReturnType;
    };
  }
}

export const ArtifactNode = Node.create({
  name: ARTIFACT_NODE_NAME,

  // Block container; holds arbitrary block-level content (paragraphs,
  // lists, code blocks, etc.). Never inline.
  group: "block",
  content: "block+",
  defining: true,

  // Selecting the wrapper should pull through to its content, not collapse
  // it into a single atomic selection. Atoms are wrong here — we want
  // ProseMirror to traverse the children.
  atom: false,
  selectable: false,

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
      version: {
        default: 1,
        parseHTML: (el) => {
          const raw = el.getAttribute("data-version");
          return raw ? Number(raw) : 1;
        },
        renderHTML: (attrs) => ({ "data-version": String(attrs.version) }),
      },
      generatedAt: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-generated-at") ?? "",
        renderHTML: (attrs) => ({ "data-generated-at": attrs.generatedAt }),
      },
      modelId: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-model-id") ?? "",
        renderHTML: (attrs) => ({ "data-model-id": attrs.modelId }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div.prismical-artifact-node",
        // Tell ProseMirror to look inside the inner content div when
        // hydrating children from HTML; the sparkle gutter has no content.
        contentElement: "div.prismical-artifact-node__content",
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    // ProseMirror DOMOutputSpec: the `0` placeholder is the contentDOM
    // hole where children render. The sparkle is non-editable chrome.
    const skillName = String(node.attrs.skillName ?? "");
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        class: "prismical-artifact-node",
      }),
      [
        "span",
        {
          class: "prismical-artifact-node__sparkle",
          contenteditable: "false",
          "data-skill-name": skillName,
        },
        "✨",
      ],
      ["div", { class: "prismical-artifact-node__content" }, 0],
    ];
  },

  addCommands() {
    return {
      insertArtifactBlock:
        (payload) =>
        ({ commands, state, tr, dispatch }) => {
          // Regen invariant: re-running an `append-section` skill walks the
          // doc for an existing artifact block with matching skillId and
          // replaces its children + bumps its metadata in place. This keeps
          // the node's identity stable (cursor position, scroll anchor) and
          // ensures the same skill never produces duplicate blocks.
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

          let newNode;
          try {
            newNode = state.schema.nodes[ARTIFACT_NODE_NAME].create(
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
            // Malformed payload (skill output didn't match the schema).
            // Fail the command quietly rather than throwing out of TipTap's
            // command runner, which would crash the editor.
            console.warn(
              "insertArtifactBlock: failed to materialize node from payload",
              err,
            );
            return false;
          }

          if (existingPos !== null) {
            const existing = state.doc.nodeAt(existingPos);
            if (existing) {
              if (dispatch) {
                tr.replaceWith(
                  existingPos,
                  existingPos + existing.nodeSize,
                  newNode,
                );
              }
              return true;
            }
          }

          // No existing block; append to the end of the doc.
          return commands.insertContentAt(state.doc.content.size, newNode.toJSON());
        },
    };
  },
});
