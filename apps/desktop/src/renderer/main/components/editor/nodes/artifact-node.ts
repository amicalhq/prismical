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

export type SerializedArtifactNode = Spread<
  ArtifactNodeMetadata,
  SerializedElementNode
>;

export class ArtifactNode extends ElementNode {
  __artifactId: string;
  __skillId: string;
  __skillName: string;
  __version: number;
  __generatedAt: string;
  __modelId: string;

  static getType(): string {
    return "artifact";
  }

  static clone(node: ArtifactNode): ArtifactNode {
    return new ArtifactNode(
      {
        artifactId: node.__artifactId,
        skillId: node.__skillId,
        skillName: node.__skillName,
        version: node.__version,
        generatedAt: node.__generatedAt,
        modelId: node.__modelId,
      },
      node.__key,
    );
  }

  constructor(metadata: ArtifactNodeMetadata, key?: NodeKey) {
    super(key);
    this.__artifactId = metadata.artifactId;
    this.__skillId = metadata.skillId;
    this.__skillName = metadata.skillName;
    this.__version = metadata.version;
    this.__generatedAt = metadata.generatedAt;
    this.__modelId = metadata.modelId;
  }

  // -------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "prismical-artifact-node";
    wrapper.dataset.artifactId = this.__artifactId;
    wrapper.dataset.skillId = this.__skillId;
    wrapper.dataset.version = String(this.__version);

    // Chrome: header bar. Note these are non-editable visual elements;
    // children flow into a separate content container that Lexical writes to.
    const header = document.createElement("div");
    header.className = "prismical-artifact-node__header";
    header.contentEditable = "false";
    header.setAttribute("data-lexical-decorator", "true");

    const badge = document.createElement("span");
    badge.className = "prismical-artifact-node__badge";
    badge.textContent = `✨ ${this.__skillName}`;
    header.appendChild(badge);

    const versionPill = document.createElement("span");
    versionPill.className = "prismical-artifact-node__version";
    versionPill.textContent = `v${this.__version}`;
    header.appendChild(versionPill);

    wrapper.appendChild(header);

    // Content container — Lexical writes children here.
    const content = document.createElement("div");
    content.className = "prismical-artifact-node__content";
    wrapper.appendChild(content);

    return wrapper;
  }

  // Updates to internal metadata are reflected by re-rendering the chrome.
  // Returning `true` tells Lexical to call `createDOM` again on the next
  // reconciliation. We do this only when chrome-visible fields changed.
  updateDOM(prevNode: ArtifactNode, _dom: HTMLElement): boolean {
    return (
      prevNode.__skillName !== this.__skillName ||
      prevNode.__version !== this.__version
    );
  }

  // Children render into the content container, not the header.
  // We delegate to the base class and redirect it to the content div so that
  // Lexical's reconciler places child nodes inside `.prismical-artifact-node__content`
  // rather than the wrapper itself.
  getDOMSlot(elementDOM: HTMLElement) {
    const content = elementDOM.querySelector(
      ".prismical-artifact-node__content",
    ) as HTMLElement | null;
    if (!content) {
      throw new Error(
        "ArtifactNode DOM is missing __content child — createDOM contract broken",
      );
    }
    return super.getDOMSlot(elementDOM).withElement(content);
  }

  // -------------------------------------------------------------------
  // JSON serialization
  // -------------------------------------------------------------------

  static importJSON(serialized: SerializedArtifactNode): ArtifactNode {
    return $createArtifactNode({
      artifactId: serialized.artifactId,
      skillId: serialized.skillId,
      skillName: serialized.skillName,
      version: serialized.version,
      generatedAt: serialized.generatedAt,
      modelId: serialized.modelId,
    }).updateFromJSON(serialized);
  }

  exportJSON(): SerializedArtifactNode {
    return {
      ...super.exportJSON(),
      type: "artifact",
      version: this.__version,
      artifactId: this.__artifactId,
      skillId: this.__skillId,
      skillName: this.__skillName,
      generatedAt: this.__generatedAt,
      modelId: this.__modelId,
    };
  }

  // -------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------

  getArtifactId(): string {
    return this.getLatest().__artifactId;
  }

  getSkillId(): string {
    return this.getLatest().__skillId;
  }

  getSkillName(): string {
    return this.getLatest().__skillName;
  }

  getVersion(): number {
    return this.getLatest().__version;
  }

  getGeneratedAt(): string {
    return this.getLatest().__generatedAt;
  }

  getModelId(): string {
    return this.getLatest().__modelId;
  }

  // Mutator — used by the runtime when a skill regen completes. Replaces
  // artifactId / version / generatedAt / modelId in place. Children are
  // replaced via normal Lexical writes by the runtime, not here.
  //
  // Updating `artifactId` is required: each accepted run gets a fresh audit
  // row, so the node must point at the latest row's id (the regenerate /
  // hover-chip-to-audit affordances would otherwise reference v1's row
  // while the node displays v2's metadata).
  updateMetadata(patch: {
    artifactId: string;
    version: number;
    generatedAt: string;
    modelId: string;
  }): this {
    const writable = this.getWritable();
    writable.__artifactId = patch.artifactId;
    writable.__version = patch.version;
    writable.__generatedAt = patch.generatedAt;
    writable.__modelId = patch.modelId;
    return writable;
  }

  // -------------------------------------------------------------------
  // Block-level semantics
  // -------------------------------------------------------------------

  // ArtifactNode is a top-level block container; it must always live at
  // the root or inside another block (never inline).
  isInline(): false {
    return false;
  }

  // It's a complete unit — selecting "all" via Cmd-A should select its
  // content not the wrapper itself, and the wrapper shouldn't accept
  // adjacent text merging.
  canIndent(): false {
    return false;
  }

  canMergeWith(_node: LexicalNode): boolean {
    return false;
  }
}

export function $createArtifactNode(
  metadata: ArtifactNodeMetadata,
): ArtifactNode {
  return $applyNodeReplacement(new ArtifactNode(metadata));
}

export function $isArtifactNode(
  node: LexicalNode | null | undefined,
): node is ArtifactNode {
  return node instanceof ArtifactNode;
}
