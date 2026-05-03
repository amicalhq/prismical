import type { ModelSelection } from "@/db/schema";

// UI components (Select, Combobox, etc.) need a single string value per
// option. Compose / parse the canonical opaque key here so callers don't
// hand-roll string concatenation.

// Invariant: `instanceId` must NEVER contain `::` so the first occurrence is
// always the separator. `modelId` may contain `::` (some self-hosted /
// OpenAI-compatible servers expose ids like `org/repo::variant`) — this is
// why `keyToSelection` splits on `indexOf`, not `split`. Don't change to
// `.split(SEPARATOR)` or `.lastIndexOf(SEPARATOR)`.
const SEPARATOR = "::";

export function selectionToKey(selection: ModelSelection): string {
  return `${selection.instanceId}${SEPARATOR}${selection.modelId}`;
}

export function keyToSelection(value: string): ModelSelection | null {
  const separatorIndex = value.indexOf(SEPARATOR);
  if (separatorIndex === -1) return null;

  const instanceId = value.slice(0, separatorIndex);
  const modelId = value.slice(separatorIndex + SEPARATOR.length);

  if (!instanceId || !modelId) return null;

  return { instanceId, modelId };
}

export function selectionsEqual(
  a: ModelSelection | null | undefined,
  b: ModelSelection | null | undefined,
): boolean {
  // Treat null and undefined as equivalent — both mean "no selection."
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.instanceId === b.instanceId && a.modelId === b.modelId;
}
