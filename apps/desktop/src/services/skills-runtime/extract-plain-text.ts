// Walks a Lexical editor-state JSON and returns its concatenated text.
// Top-level block children are separated by "\n\n"; inline children are
// concatenated within their block. Used by `read_note` (to brief the agent)
// AND by the runner's `replace-doc` flow (to compute the "before" text
// for the char-level diff overlay).
//
// Returns "" on parse failure or empty content — callers treat that as
// "no body" rather than surfacing the error.
export function extractPlainText(stateJson: string): string {
  try {
    const parsed = JSON.parse(stateJson);
    const root = parsed?.root;
    if (!root || !Array.isArray(root.children)) return "";
    return root.children
      .map((child: unknown) => extractNodeText(child as LexicalNodeLike))
      .filter((text: string) => text.length > 0)
      .join("\n\n");
  } catch {
    return "";
  }
}

interface LexicalNodeLike {
  type?: string;
  text?: string;
  children?: LexicalNodeLike[];
}

function extractNodeText(node: LexicalNodeLike): string {
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.children)) {
    return node.children.map(extractNodeText).join("");
  }
  return "";
}
