// Plain-text → TipTap doc JSON bootstrap. Used by the events / summaries
// pipeline to seed a note's content from raw transcribed text before the
// user has touched it in the editor.

interface TiptapTextNode {
  type: "text";
  text: string;
}

interface TiptapParagraphNode {
  type: "paragraph";
  content?: TiptapTextNode[];
}

interface TiptapDoc {
  type: "doc";
  content: TiptapParagraphNode[];
}

export function isTiptapEditorStateJsonString(value: string): boolean {
  if (!value) return false;

  try {
    const parsed = JSON.parse(value) as Partial<TiptapDoc> | null;
    return !!(
      parsed &&
      typeof parsed === "object" &&
      parsed.type === "doc" &&
      Array.isArray(parsed.content)
    );
  } catch {
    return false;
  }
}

export function serializePlainTextToTiptapJson(plainText: string): string {
  const lines = plainText.split(/\r?\n/);

  const paragraphs: TiptapParagraphNode[] = lines.map((line) => {
    if (line.length === 0) return { type: "paragraph" };
    return { type: "paragraph", content: [{ type: "text", text: line }] };
  });

  const doc: TiptapDoc = { type: "doc", content: paragraphs };
  return JSON.stringify(doc);
}
