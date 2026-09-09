import type { AppSearchParams } from '@prismical/app-contracts';

/** Remove a deleted collection from the current view without dropping other filters. */
export function withoutNotesFilter(
  searchParams: AppSearchParams,
  key: 'folder' | 'tags',
  id: string
): string {
  const params = new URLSearchParams(searchParams.toString());
  params.delete(key, id);
  const query = params.toString();
  return query ? `/notes?${query}` : '/notes';
}
