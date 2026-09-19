/**
 * Stable anchors for guided tours.
 *
 * A tour step - whether it is driven by the built-in walkthrough
 * (`anchored-tour.tsx`) or authored in the support tool's dashboard - has to
 * point at an element. Class names are the wrong handle: they are utility
 * classes that change whenever the layout is touched, and a tour that loses its
 * target silently strands the person following it. So every element a tour may
 * ever highlight carries `data-onboarding="<name>"`, and tours address it as
 * `[data-onboarding="<name>"]`.
 *
 * Rules for the attribute:
 *  - The value names WHAT the element is, never where it sits or how it looks.
 *  - It is part of the app's contract with the tours, so renaming one is a
 *    breaking change: a published tour keeps pointing at the old name. Prefer
 *    adding a new anchor over repurposing an existing one.
 *  - It is not a test hook. `data-testid` stays free for tests to churn on.
 *  - Several elements may share a name when only one of them is on screen at a
 *    time (the recording dock's states do this); tour lookup takes the first
 *    visible match.
 */

export const ONBOARDING_ATTRIBUTE = 'data-onboarding';

/** `[data-onboarding="new-note"]` - the selector form a tour step is given. */
export function anchorSelector(name: string): string {
  return `[${ONBOARDING_ATTRIBUTE}="${name}"]`;
}

/**
 * Anchor for a navigation row, derived from its route so the two cannot drift:
 * `/home` is `nav-home`, `/settings/api-keys` is `nav-settings-api-keys`.
 * Every sidebar row - primary and settings - is anchored this way, which is why
 * no list of route anchors is maintained by hand.
 */
export function navAnchor(url: string): string {
  return `nav-${url.replace(/^\/+/, '').replace(/\//g, '-') || 'root'}`;
}

/**
 * The anchors that are not derived from a route, as one list. It is the
 * reference a tour author reads, and the fixture the coverage test asserts the
 * app still renders - so an anchor deleted from a component fails here rather
 * than in a customer's tour.
 */
export const ONBOARDING_ANCHORS = {
  /** Shell: sidebar, header and the footer controls. */
  shell: [
    'sidebar-brand',
    'sidebar-search',
    'sidebar-favorites',
    'sidebar-folders',
    'sidebar-tags',
    'sidebar-cta',
    'sidebar-account',
    'sidebar-usage',
    'sidebar-download',
    'sidebar-help',
    'page-header',
  ],
  /** One per top-level screen, on the screen's own root. */
  screens: [
    'screen-home',
    'screen-notes',
    'screen-shared',
    'screen-people',
    'screen-companies',
    'screen-events',
    'screen-note',
  ],
  /** Note surface: the editor's own actions and metadata rows. */
  note: ['note-body', 'note-share', 'note-star', 'note-actions', 'note-folder', 'note-tags'],
  /**
   * Capture and review. These are the built-in walkthrough's anchors; several
   * name a state of the same control, and `anchored-tour.tsx` owns the order
   * they are tried in.
   */
  capture: [
    'new-note',
    'record-open',
    'record-pending',
    'record-start',
    'record-live-open',
    'record-stop',
    'record-saving',
    'record-retry',
    'transcript',
    'transcript-wait',
    'enhance',
    'skill-status',
    'review-controls',
  ],
} as const;
