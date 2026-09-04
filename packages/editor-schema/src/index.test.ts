import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { getEditorSchema, buildEditorExtensions } from './index.js';

// A ProseMirror doc JSON exercising every node type the schema must support.
const fullDoc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] },
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'title text' }] },
    {
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [{ type: 'text', text: 'const x = 1' }],
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a task' }] }],
        },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'h1' }] }],
            },
            {
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'c1' }] }],
            },
          ],
        },
      ],
    },
    {
      type: 'artifact',
      attrs: {
        artifactId: 'a1',
        skillId: 's1',
        skillName: 'Summarize',
        version: 1,
        generatedAt: '',
        modelId: 'm1',
      },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'artifact body' }] }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'before ' },
        {
          type: 'artifact-inline',
          attrs: { artifactId: 'a2', skillId: 's2', skillName: 'Rewrite' },
          content: [{ type: 'text', text: 'inline body' }],
        },
      ],
    },
  ],
};

describe('editor schema parity', () => {
  it('deserializes every node type without throwing', () => {
    const schema = getEditorSchema();
    const node = schema.nodeFromJSON(fullDoc);
    expect(node).toBeDefined();
  });

  it('extracts plaintext across node types', () => {
    const schema = getEditorSchema();
    const text = schema.nodeFromJSON(fullDoc).textContent;
    expect(text).toContain('hello world');
    expect(text).toContain('a task');
    expect(text).toContain('artifact body');
    expect(text).toContain('inline body');
  });

  it('throws on an unknown node type (drift guard)', () => {
    const schema = getEditorSchema();
    expect(() =>
      schema.nodeFromJSON({ type: 'doc', content: [{ type: 'totally-unknown-node' }] })
    ).toThrow();
  });
});

describe('buildEditorExtensions undoRedo toggle', () => {
  it('undoRedo:false yields the SAME node/mark schema as default (schema parity)', () => {
    const def = getSchema(buildEditorExtensions());
    const noUndo = getSchema(buildEditorExtensions({ undoRedo: false }));
    expect(Object.keys(noUndo.nodes)).toEqual(Object.keys(def.nodes));
    expect(Object.keys(noUndo.marks)).toEqual(Object.keys(def.marks));
  });
});
