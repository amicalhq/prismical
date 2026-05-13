import {
  $applyNodeReplacement,
  ElementNode,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from "lexical";

// Inline-level wrapper around AI-rewritten text. No version field — inline
// rewrites are one-shot (regen replaces children atomically, not versioned).
// No visible chrome — the hover chip is rendered via a CSS `::after`
// pseudo-element on the `.prismical-artifact-inline` class.
export interface ArtifactInlineNodeMetadata {
  artifactId: string;
  skillId: string;
  skillName: string;
}

export type SerializedArtifactInlineNode = Spread<
  ArtifactInlineNodeMetadata,
  SerializedElementNode
>;

export class ArtifactInlineNode extends ElementNode {
  __artifactId: string;
  __skillId: string;
  __skillName: string;

  static getType(): string {
    return "artifact-inline";
  }

  static clone(node: ArtifactInlineNode): ArtifactInlineNode {
    return new ArtifactInlineNode(
      {
        artifactId: node.__artifactId,
        skillId: node.__skillId,
        skillName: node.__skillName,
      },
      node.__key,
    );
  }

  constructor(metadata: ArtifactInlineNodeMetadata, key?: NodeKey) {
    super(key);
    this.__artifactId = metadata.artifactId;
    this.__skillId = metadata.skillId;
    this.__skillName = metadata.skillName;
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const span = document.createElement("span");
    span.className = "prismical-artifact-inline";
    span.dataset.artifactId = this.__artifactId;
    span.dataset.skillId = this.__skillId;
    span.dataset.skillName = this.__skillName;
    // The hover chip is purely CSS — see artifact-node.css.
    return span;
  }

  updateDOM(prevNode: ArtifactInlineNode, dom: HTMLElement): boolean {
    if (prevNode.__skillName !== this.__skillName) {
      dom.dataset.skillName = this.__skillName;
    }
    if (prevNode.__skillId !== this.__skillId) {
      dom.dataset.skillId = this.__skillId;
    }
    return false; // never re-create; mutating data-attrs is enough
  }

  static importJSON(
    serialized: SerializedArtifactInlineNode,
  ): ArtifactInlineNode {
    return $createArtifactInlineNode({
      artifactId: serialized.artifactId,
      skillId: serialized.skillId,
      skillName: serialized.skillName,
    }).updateFromJSON(serialized);
  }

  exportJSON(): SerializedArtifactInlineNode {
    return {
      ...super.exportJSON(),
      type: "artifact-inline",
      version: 1,
      artifactId: this.__artifactId,
      skillId: this.__skillId,
      skillName: this.__skillName,
    };
  }

  // Inline semantics: lives inside paragraphs, headings, list items, etc.
  isInline(): true {
    return true;
  }

  // Children are atomic — re-running the inline-rewrite replaces them as a
  // batch, but interleaved editing is supported (it's just inline text).
  canBeEmpty(): false {
    return false;
  }

  getArtifactId(): string {
    return this.getLatest().__artifactId;
  }

  getSkillId(): string {
    return this.getLatest().__skillId;
  }

  getSkillName(): string {
    return this.getLatest().__skillName;
  }

  // Mutator — used by the runtime when an inline-rewrite regen replaces this
  // node in place. Only `artifactId` changes; `skillId` / `skillName` are
  // identity (a regen of the same skill, not a different skill).
  updateArtifactId(artifactId: string): this {
    const writable = this.getWritable();
    writable.__artifactId = artifactId;
    return writable;
  }
}

export function $createArtifactInlineNode(
  metadata: ArtifactInlineNodeMetadata,
): ArtifactInlineNode {
  return $applyNodeReplacement(new ArtifactInlineNode(metadata));
}

export function $isArtifactInlineNode(
  node: LexicalNode | null | undefined,
): node is ArtifactInlineNode {
  return node instanceof ArtifactInlineNode;
}
