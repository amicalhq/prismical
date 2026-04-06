export function normalizeGeneratedMarkdown(markdown: string): string {
  const trimmed = markdown.trim();
  const fencedMatch = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);

  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  return trimmed;
}
