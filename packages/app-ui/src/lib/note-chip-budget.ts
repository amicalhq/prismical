/**
 * How many chips of each kind fit on a note row's single line.
 *
 * A note is usually about ONE meeting, so the line shows that one and counts the rest. Tags are the
 * opposite — a note collects many, and which ones it carries is most of what the line is for — so
 * they take every slot the folder and the meeting leave.
 *
 * The counters are not charged to the budget. A "+4" is a fraction of the width of the chip it
 * stands for, and charging it a full slot took the space out of the tags, which is exactly where it
 * should not have come from.
 *
 * Each kind counts separately, since a single mixed count would leave you unable to tell whether
 * the hidden items were meetings or tags.
 *
 * A fixed budget rather than a measured fit: measuring means a ResizeObserver and a layout pass per
 * row, which is a lot to run down a long list for chips that already truncate individually. What
 * the budget misjudges still clips at the row's edge.
 */
const CHIP_BUDGET = 5;

/** How many meetings and tags to draw; the caller counts whatever it had to leave out. */
export function chipBudget(
  hasFolder: boolean,
  meetings: number,
  tags: number
): { events: number; tags: number } {
  // The folder is the rarest chip and names where the note lives, so it is never the one dropped.
  const left = CHIP_BUDGET - (hasFolder ? 1 : 0);
  const events = Math.min(meetings, 1);
  return { events, tags: Math.min(tags, left - events) };
}
