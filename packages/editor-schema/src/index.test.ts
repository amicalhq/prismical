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

describe('compatibility nodes and marks written by other clients', () => {
  // Registered for compatibility only: stored bodies carry it, and a schema that does not know the
  // mark makes the server derive throw AND makes the editor's Yjs binding delete the text outright.
  // A frozen list, not a `toContain`: removing ANY mark from the shared set silently destroys text
  // in every stored body that uses it, so removal has to be a deliberate, reviewed edit here.
  it('registers exactly the marks the shared schema promises', () => {
    expect(Object.keys(getEditorSchema().marks).sort()).toEqual([
      'bold',
      'code',
      'highlight',
      'italic',
      'link',
      'strike',
      'textStyle',
      'underline',
    ]);
  });

  // Frozen like the mark list, and for a sharper reason: an unregistered NODE destroys a whole
  // block rather than one text run. Removing any of these must be a deliberate, reviewed edit.
  it('registers exactly the nodes the shared schema promises', () => {
    expect(Object.keys(getEditorSchema().nodes).sort()).toEqual([
      'artifact',
      'artifact-inline',
      'blockquote',
      'bulletList',
      'codeBlock',
      'doc',
      'emoji',
      'hardBreak',
      'heading',
      'horizontalRule',
      'image',
      'listItem',
      'orderedList',
      'paragraph',
      'table',
      'tableCell',
      'tableHeader',
      'tableRow',
      'taskItem',
      'taskList',
      'text',
    ]);
  });

  it('declares every attribute the writing client puts on a shared node', () => {
    // The silent half of schema drift: ProseMirror drops attributes a type does not declare, so a
    // divergence here loses data without ever throwing. `width`/`height` come from the image
    // extension, `tight` from the markdown list extension the other client mounts.
    const schema = getEditorSchema();
    expect(Object.keys(schema.nodes.image!.spec.attrs ?? {}).sort()).toEqual([
      'alt',
      'height',
      'src',
      'title',
      'width',
    ]);
    expect(Object.keys(schema.nodes.bulletList!.spec.attrs ?? {})).toContain('tight');
    expect(Object.keys(schema.nodes.orderedList!.spec.attrs ?? {})).toContain('tight');
  });

  it('preserves those attributes through a parse round-trip', () => {
    const node = getEditorSchema().nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'u', alt: null, title: null, width: 320, height: 200 } },
        {
          type: 'bulletList',
          attrs: { tight: false },
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
          ],
        },
      ],
    });
    expect(node.firstChild!.attrs.width).toBe(320);
    expect(node.firstChild!.attrs.height).toBe(200);
    expect(node.lastChild!.attrs.tight).toBe(false);
  });

  it('the marks have no parse rule, so pasted HTML cannot mint one', () => {
    // Decoration must only ever arrive from a stored document. A `span`-matching rule here would
    // quietly turn a compatibility shim into an inline-CSS import for every paste. (The image is
    // the exception and is covered below: its rule matches only its own placeholder.)
    const schema = getEditorSchema();
    expect(schema.marks.textStyle!.spec.parseDOM ?? []).toEqual([]);
    expect(schema.marks.highlight!.spec.parseDOM ?? []).toEqual([]);
  });

  it('renders none of them — they are readable, never visible', () => {
    // This editor offers neither inline colour, nor a marker pen, nor images. Drawing any of them
    // would make a feature of something nothing here can author, and text coloured for a dark phone
    // theme would be unreadable against a different background. The nodes and marks still occupy
    // their positions, so nothing is lost or rewritten — it is simply not displayed.
    const schema = getEditorSchema();

    const styled = schema.marks.textStyle!.create({ color: 'red', fontSize: '40px' });
    expect(JSON.stringify(schema.marks.textStyle!.spec.toDOM!(styled, true))).not.toContain('red');
    expect(JSON.stringify(schema.marks.textStyle!.spec.toDOM!(styled, true))).not.toContain('40px');

    const marked = schema.marks.highlight!.create({ color: 'yellow' });
    expect(JSON.stringify(schema.marks.highlight!.spec.toDOM!(marked, true))).not.toContain('yellow');

    // The image renders an EMPTY placeholder: a div, never an `img`, and nothing visible. Its
    // attributes ride along as data-* so a clipboard round-trip does not delete the node (see the
    // round-trip test below) — carried, not drawn.
    const img = schema.nodes.image!.create({ src: 'https://example.com/a.png', alt: 'a shot' });
    const rendered = schema.nodes.image!.spec.toDOM!(img) as [string, Record<string, string>];
    expect(rendered[0]).toBe('div');
    expect(JSON.stringify(rendered)).not.toContain('"img"');
    expect(rendered[1]).toHaveProperty('data-prismical-image');
    expect(rendered[1]).not.toHaveProperty('style');
  });

  it('only parses its OWN placeholder, so pasted HTML cannot mint an image', () => {
    const rules = getEditorSchema().nodes.image!.spec.parseDOM ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]!.tag).toBe('div[data-prismical-image]');
  });

  it('still serializes an image to markdown, even though it is never drawn', () => {
    // Not displaying an image is a rendering decision. Dropping it from markdown would be a data
    // one: accepting a skill result serializes the note to markdown and parses the result back.
    const node = getEditorSchema().nodeFromJSON({
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'https://example.com/a.png', alt: null, title: null } }],
    });
    expect(node.firstChild!.attrs.src).toBe('https://example.com/a.png');
  });

  it('deserializes text carrying highlight without throwing', () => {
    const node = getEditorSchema().nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'marked', marks: [{ type: 'highlight', attrs: { color: 'yellow' } }] },
          ],
        },
      ],
    });
    expect(node.textContent).toBe('marked');
  });

  it('deserializes a document containing an image node', () => {
    const node = getEditorSchema().nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'shot' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    });
    expect(node.childCount).toBe(2);
    expect(node.firstChild!.type.name).toBe('image');
  });

  it('deserializes text carrying textStyle, keeping the attributes it declares', () => {
    const schema = getEditorSchema();
    const node = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'plain ' },
            {
              type: 'text',
              text: 'tinted',
              marks: [{ type: 'textStyle', attrs: { color: 'rgb(1, 2, 3)' } }],
            },
          ],
        },
      ],
    });

    expect(node.textContent).toBe('plain tinted');
    const marked = node.firstChild!.child(1);
    expect(marked.marks[0]!.type.name).toBe('textStyle');
    expect(marked.marks[0]!.attrs.color).toBe('rgb(1, 2, 3)');
  });

  it('tolerates textStyle with no attributes at all', () => {
    const schema = getEditorSchema();
    const node = schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'bare', marks: [{ type: 'textStyle' }] }] },
      ],
    });
    expect(node.textContent).toBe('bare');
  });

  it('declares only the attributes the writing client writes', () => {
    // A mark's attributes are stored in the CRDT as ONE object, so every attribute declared here is
    // written into the document on the next edit. Declaring the wider Tiptap TextStyle family put
    // backgroundColor="null", fontFamily="null", fontSize="null" and lineHeight="null" into real
    // notes — observed in the browser against a live stack, not caught by any test.
    const schema = getEditorSchema();
    expect(Object.keys(schema.marks.textStyle!.spec.attrs ?? {})).toEqual(['color']);
    expect(Object.keys(schema.marks.highlight!.spec.attrs ?? {})).toEqual(['color']);
  });

  it('does not extend onto text typed at its edge', () => {
    // Both marks are invisible here, so an inclusive one spreads silently onto new text the author
    // can neither see nor clear. Observed in the browser: typing after a coloured run pulled the
    // new words inside it.
    const schema = getEditorSchema();
    expect(schema.marks.textStyle!.spec.inclusive).toBe(false);
    expect(schema.marks.highlight!.spec.inclusive).toBe(false);
  });

  it('is a non-overlapping mark, so Yjs stores it under the plain `textStyle` key', () => {
    // Guards the ABSENCE of `excludes` in our spec. y-prosemirror/y-tiptap hash the attribute key of
    // marks that can overlap themselves (`name--<hash>`); setting `excludes: ''` here would move the
    // key off the plain name that existing documents are written under.
    const textStyle = getEditorSchema().marks.textStyle!;
    expect(textStyle.excludes(textStyle)).toBe(true);
  });

  it('throws on an unknown mark type (drift guard)', () => {
    const schema = getEditorSchema();
    expect(() =>
      schema.nodeFromJSON({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'martianMark' }] }] },
        ],
      })
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
