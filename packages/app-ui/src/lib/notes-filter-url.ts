import type { AppSearchParams } from '@prismical/app-contracts';

/** Remove a deleted collection from the current view without dropping other filters. */
export function withoutNotesFilter(
  searchParams: AppSearchParams,
  key: 'folder' | 'tags',
  id: string
): string {
  // Rebuilt rather than `params.delete(key, id)`: the two-argument form is recent enough that an
  // older engine silently ignores the value and drops EVERY value of the key — removing one tag
  // would clear the whole tag filter.
  const source = new URLSearchParams(searchParams.toString());
  const params = new URLSearchParams();
  for (const [name, value] of source) {
    if (name === key && value === id) continue;
    params.append(name, value);
  }
  const query = params.toString();
  return query ? `/notes?${query}` : '/notes';
}
