import { Node, mergeAttributes } from '@tiptap/core';

export const ARTIFACT_NODE_NAME = 'artifact' as const;

// Schema-only mirror of the desktop ArtifactNode
// (apps/desktop/.../editor/nodes/artifact-node.ts). Renderer-coupled bits
// (addCommands/addNodeView/keymap plugins) are intentionally omitted — the
// server only needs schema parity to deserialize Y.Docs without throwing.
export const ArtifactNode = Node.create({
  name: ARTIFACT_NODE_NAME,
  group: 'block',
  content: 'block+',
  defining: true,
  atom: false,
  selectable: false,

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
      version: {
        default: 1,
        parseHTML: el => {
          const raw = el.getAttribute('data-version');
          return raw ? Number(raw) : 1;
        },
        renderHTML: attrs => ({ 'data-version': String(attrs.version) }),
      },
      generatedAt: {
        default: '',
        parseHTML: el => el.getAttribute('data-generated-at') ?? '',
        renderHTML: attrs => ({ 'data-generated-at': attrs.generatedAt }),
      },
      modelId: {
        default: '',
        parseHTML: el => el.getAttribute('data-model-id') ?? '',
        renderHTML: attrs => ({ 'data-model-id': attrs.modelId }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div.prismical-artifact-node',
        contentElement: 'div.prismical-artifact-node__content',
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    const skillName = String(node.attrs.skillName ?? '');
    return [
      'div',
      mergeAttributes(HTMLAttributes, { class: 'prismical-artifact-node' }),
      [
        'span',
        {
          class: 'prismical-artifact-node__sparkle',
          contenteditable: 'false',
          'data-skill-name': skillName,
        },
        '✨',
      ],
      ['div', { class: 'prismical-artifact-node__content' }, 0],
    ];
  },
});
