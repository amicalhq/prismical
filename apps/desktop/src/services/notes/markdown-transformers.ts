import type { LexicalNode } from "lexical";
import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  HorizontalRuleNode,
} from "@lexical/extension";
import {
  TRANSFORMERS,
  type ElementTransformer,
  type Transformer,
} from "@lexical/markdown";

// `@lexical/markdown` deliberately ships no HR transformer — `HorizontalRuleNode`
// lives in `@lexical/extension`, and the markdown package stays Node-set-agnostic.
// Mirrors the official Lexical playground's HR transformer; emits `---` to match
// our existing hand-rolled exporter at services/notes/lexical-to-markdown.ts.
export const HR: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  export: (node: LexicalNode) =>
    $isHorizontalRuleNode(node) ? "---" : null,
  regExp: /^(---|\*\*\*|___)\s?$/,
  replace: (parentNode, _children, _match, isImport) => {
    const line = $createHorizontalRuleNode();
    if (isImport || parentNode.getNextSibling() != null) {
      parentNode.replace(line);
    } else {
      parentNode.insertBefore(line);
    }
    line.selectNext();
  },
  type: "element",
};

export const MARKDOWN_TRANSFORMERS: Array<Transformer> = [HR, ...TRANSFORMERS];
