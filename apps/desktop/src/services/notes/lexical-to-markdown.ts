// Walk the Lexical state JSON tree and emit GitHub-flavored markdown.
// ArtifactNode + ArtifactInlineNode wrappers are unwrapped — their
// children render as if they were native text (so sharing a note doesn't
// leak the fact that AI generated parts of it).

export function lexicalStateToMarkdown(stateJson: string): string {
  const parsed = JSON.parse(stateJson);
  return renderChildren(parsed.root?.children ?? []);
}

function renderChildren(children: unknown[]): string {
  return children
    .map((node) => renderNode(node as Record<string, unknown>))
    .filter(Boolean)
    .join("\n\n");
}

function renderNode(node: Record<string, unknown>): string {
  const children = (node.children ?? []) as unknown[];
  switch (node.type) {
    case "paragraph":
      return renderInlineChildren(children);
    case "heading": {
      const tag = typeof node.tag === "string" ? node.tag : "h1";
      const level = parseInt(tag.slice(1) ?? "1", 10);
      return `${"#".repeat(level)} ${renderInlineChildren(children)}`;
    }
    case "list": {
      const isOrdered = node.listType === "number";
      return (children as Record<string, unknown>[])
        .map((item, i) => {
          const itemChildren = (item.children ?? []) as unknown[];
          return `${isOrdered ? `${i + 1}.` : "-"} ${renderInlineChildren(itemChildren)}`;
        })
        .join("\n");
    }
    case "code":
      return "```\n" + renderInlineChildren(children) + "\n```";
    case "quote":
      return "> " + renderInlineChildren(children);
    case "horizontalrule":
      return "---";
    case "artifact":
      return renderChildren(children); // unwrap
    case "artifact-inline":
      return renderInlineChildren(children); // unwrap
    default:
      return renderInlineChildren(children);
  }
}

function renderInlineChildren(children: unknown[]): string {
  return (children as Record<string, unknown>[])
    .map(renderInlineNode)
    .join("");
}

function renderInlineNode(node: Record<string, unknown>): string {
  if (node.type === "text") {
    let text = (node.text as string) ?? "";
    const format = (node.format as number) ?? 0;
    if (format & 1) text = `**${text}**`;
    if (format & 2) text = `*${text}*`;
    if (format & 16) text = `\`${text}\``;
    return text;
  }
  if (node.type === "link") {
    const url = (node.url as string) ?? "";
    const linkChildren = (node.children ?? []) as unknown[];
    return `[${renderInlineChildren(linkChildren)}](${url})`;
  }
  if (node.type === "artifact-inline") {
    const inlineChildren = (node.children ?? []) as unknown[];
    return renderInlineChildren(inlineChildren); // unwrap
  }
  const fallbackChildren = (node.children ?? []) as unknown[];
  return renderInlineChildren(fallbackChildren);
}
