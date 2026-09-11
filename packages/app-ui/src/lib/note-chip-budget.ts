/**
 * How many chips a note row draws, across its two lines.
 *
 * Tags ride WITH the title — they name what the note is about, so they belong beside the name
 * rather than under it — while the folder and the meetings sit on the metadata line beneath.
 * Each line therefore gets its own budget: what the title line spends on tags does not come out
 * of the meetings, and neither can push the other off the row.
 *
 * The counters ("+4") are not charged to either budget. A counter is a fraction of the width of
 * the chip it stands for, and charging it a full slot takes the space out of the chips it was
 * meant to summarise.
 *
 * Each kind counts separately, since a single mixed count would leave you unable to tell whether
 * the hidden items were meetings or tags.
 *
 * Fixed budgets rather than a measured fit: measuring means a ResizeObserver and a layout pass per
 * row, which is a lot to run down a long list for chips that already truncate individually. What
 * the budget misjudges still clips at the row's edge.
 */

/**
 * Tags shown beside the title before the row starts counting them. They share this line with the
 * note's own name, and the name is what the row is for, so the line takes what fits and hands the
 * rest to a counter.
 */
const TAG_BUDGET = 3;

/**
 * A note is usually about ONE meeting, and a meeting chip is wide — it carries a whole invite
 * title. So the line shows the primary one and counts the rest rather than spending the row on
 * every meeting a note happens to be linked to.
 */
const MEETING_BUDGET = 1;

/** How many tags to draw beside the title; the caller counts whatever it had to leave out. */
export function tagBudget(tags: number): number {
  return Math.min(tags, TAG_BUDGET);
}

/** How many meetings the metadata line draws; the caller counts the rest. */
export function meetingBudget(meetings: number): number {
  return Math.min(meetings, MEETING_BUDGET);
}
