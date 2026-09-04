import { Node, mergeAttributes } from '@tiptap/core';

export const ARTIFACT_INLINE_NODE_NAME = 'artifact-inline' as const;

// Schema-only mirror of the desktop ArtifactInlineNode
// (apps/desktop/.../editor/nodes/artifact-inline-node.ts). Renderer-coupled
// bits omitted; schema fields kept byte-identical for parity.
export const ArtifactInlineNode = Node.create({
  name: ARTIFACT_INLINE_NODE_NAME,
  inline: true,
  group: 'inline',
  content: 'inline*',
  defining: true,
  selectable: false,
  atom: false,

  addAttributes() {
    return {
      artifactId: {
        default: '',
        parseHTML: el => el.getAttribute('data-artifact-id') ?? '',
        renderHTML: attrs => ({ 'data-artifact-id': attrs.artifactId }),
      },
      skillId: {
        default: '',
        parseHTML: el => el.getAttribute('data-skill-id') ?? '',
        renderHTML: attrs => ({ 'data-skill-id': attrs.skillId }),
      },
      skillName: {
        default: '',
        parseHTML: el => el.getAttribute('data-skill-name') ?? '',
        renderHTML: attrs => ({ 'data-skill-name': attrs.skillName }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span.prismical-artifact-inline' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'prismical-artifact-inline' }), 0];
  },
});
