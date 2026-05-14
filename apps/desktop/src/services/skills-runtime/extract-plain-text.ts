// Walks a ProseMirror/TipTap editor-state JSON and returns its concatenated
// text. Accepts either a pre-parsed object (from yXmlFragmentToProsemirrorJSON)
// or a JSON string (legacy Lexical format — kept for any remaining callers).
// Top-level block children are separated by "\n\n"; inline text nodes are
// concatenated within their block. Used by `read_note` (to brief the agent)
// AND by the runner's `replace-doc` flow (to compute the "before" text
// for the char-level diff overlay).
//
// Returns "" on parse failure or empty content — callers treat that as
// "no body" rather than surfacing the error.
export function extractPlainText(stateJson: string | object): string {
  try {
    const parsed =
      typeof stateJson === "string" ? JSON.parse(stateJson) : stateJson;

    // ProseMirror/TipTap JSON: { type: "doc", content: [...] }
    if (parsed?.type === "doc" && Array.isArray(parsed.content)) {
      return parsed.content
        .map((node: unknown) => extractPmNodeText(node as PmNodeLike))
        .filter((text: string) => text.length > 0)
        .join("\n\n");
    }

    // Legacy Lexical JSON: { root: { children: [...] } }
    const root = parsed?.root;
    if (root && Array.isArray(root.children)) {
      return root.children
        .map((child: unknown) => extractLexicalNodeText(child as LexicalNodeLike))
        .filter((text: string) => text.length > 0)
        .join("\n\n");
    }

    return "";
  } catch {
    return "";
  }
}

// --- ProseMirror/TipTap node walker ---

interface PmNodeLike {
  type?: string;
  text?: string;
  content?: PmNodeLike[];
}

function extractPmNodeText(node: PmNodeLike): string {
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.content)) {
    return node.content.map(extractPmNodeText).join("");
  }
  return "";
}

// --- Legacy Lexical node walker ---

interface LexicalNodeLike {
  type?: string;
  text?: string;
  children?: LexicalNodeLike[];
}

function extractLexicalNodeText(node: LexicalNodeLike): string {
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.children)) {
    return node.children.map(extractLexicalNodeText).join("");
  }
  return "";
}
