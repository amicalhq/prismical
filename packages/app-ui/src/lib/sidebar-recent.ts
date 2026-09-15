/**
 * What the sidebar's folders and tags groups show: the newest few, and then the next few, and so
 * on as "Show more" is pressed.
 *
 * Newest by creation is the rule, because Favorites — its own group above, and available on both
 * folders and tags — is how something older gets pinned here; what is new is what you have not yet
 * decided about.
 *
 * The list is strictly a PREFIX of that one order, and that is the point: every row keeps its
 * position for as long as it is on screen, and paging only ever adds rows beneath the ones already
 * there. Nothing is injected for being the current folder or tag. That used to happen — whatever
 * you had selected was appended to the window if the cap had dropped it — and it meant the list
 * changed shape when you selected something, with the appended row sitting out of order at the
 * bottom until the window grew past it, then jumping into its real place.
 *
 * The cost is that the sidebar cannot mark where you are when where you are has not been paged to
 * yet. The notes screen names the active folder and tags itself, so that is the smaller loss.
 */
export function newestFirst<T extends { id: string; createdAt: string }>(
  items: readonly T[],
  limit: number
): T[] {
  // Sort before the slice: the sync lane hands rows back oldest-first, so slicing straight off the
  // collection would pin these groups to the oldest rows and never surface a new one.
  return [...items]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}
