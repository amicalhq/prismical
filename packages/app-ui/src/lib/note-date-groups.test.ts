import { describe, expect, it } from 'vitest';
import type { ApplicationTFunction } from '@prismical/app-i18n';
import { groupNotesByDate } from './note-date-groups';

// Keys stand in for the catalog so the assertions read as the buckets themselves.
const t = ((key: string) => key) as unknown as ApplicationTFunction;
const now = new Date(2026, 8, 9, 14, 30); // Wed 9 Sep 2026

/** Group labels in render order, each with the dates that landed under it. */
function group(dates: Date[]) {
  return groupNotesByDate(dates, date => date, now, 'en', t).map(g => ({
    label: g.label,
    count: g.notes.length,
  }));
}

describe('note date groups', () => {
  it('walks a descending list into today, yesterday, this month, months, then years', () => {
    expect(
      group([
        new Date(2026, 8, 9, 9, 0),
        new Date(2026, 8, 8, 23, 0),
        new Date(2026, 8, 2),
        new Date(2026, 8, 1),
        new Date(2026, 7, 20),
        new Date(2026, 6, 4),
        new Date(2025, 11, 31),
        new Date(2025, 0, 2),
        new Date(2024, 5, 1),
      ])
    ).toEqual([
      { label: 'notes.list.today', count: 1 },
      { label: 'common.time.yesterday', count: 1 },
      { label: 'notes.list.earlierThisMonth', count: 2 },
      { label: 'August', count: 1 },
      { label: 'July', count: 1 },
      { label: '2025', count: 2 },
      { label: '2024', count: 1 },
    ]);
  });

  // The buckets nest, so a heading is always true of everything beneath it — no rolling window
  // splits a month across two headings.
  it('keeps a whole calendar month under one heading', () => {
    const august = [new Date(2026, 7, 31), new Date(2026, 7, 15), new Date(2026, 7, 1)];
    expect(group(august)).toEqual([{ label: 'August', count: 3 }]);
  });

  it('starts today at local midnight, not 24 hours back', () => {
    // 00:05 today and 23:55 yesterday are 10 minutes apart and still belong to different days.
    expect(group([new Date(2026, 8, 9, 0, 5), new Date(2026, 8, 8, 23, 55)])).toEqual([
      { label: 'notes.list.today', count: 1 },
      { label: 'common.time.yesterday', count: 1 },
    ]);
  });

  it('files a note saved slightly in the future under today', () => {
    expect(group([new Date(2026, 8, 9, 23, 59)])).toEqual([
      { label: 'notes.list.today', count: 1 },
    ]);
  });

  // On the 1st, yesterday belongs to the previous month: the more specific heading wins, and the
  // month heading below covers the rest of it.
  it('prefers yesterday over the month it falls in', () => {
    const firstOfMonth = new Date(2026, 8, 1, 10, 0);
    const groups = groupNotesByDate(
      [new Date(2026, 7, 31, 18, 0), new Date(2026, 7, 30)],
      date => date,
      firstOfMonth,
      'en',
      t
    );
    expect(groups.map(g => ({ label: g.label, count: g.notes.length }))).toEqual([
      { label: 'common.time.yesterday', count: 1 },
      { label: 'August', count: 1 },
    ]);
  });

  it('follows an ascending list rather than imposing its own order', () => {
    expect(group([new Date(2025, 2, 1), new Date(2026, 7, 4), new Date(2026, 8, 9)])).toEqual([
      { label: '2025', count: 1 },
      { label: 'August', count: 1 },
      { label: 'notes.list.today', count: 1 },
    ]);
  });

  it('localizes month and year headings', () => {
    const labels = groupNotesByDate(
      [new Date(2026, 7, 4), new Date(2025, 3, 2)],
      date => date,
      now,
      'ja',
      t
    ).map(g => g.label);
    expect(labels).toEqual(['8月', '2025年']);
  });

  // Buckets exist only where notes do: the walk opens a section when it meets one, so a month
  // nobody wrote in never gets a heading.
  it('skips the months and years that hold nothing', () => {
    expect(
      group([
        new Date(2026, 8, 9),
        new Date(2026, 5, 12), // June — May, July and August are all empty
        new Date(2023, 1, 3), // 2023 — 2024 and 2025 are empty
      ])
    ).toEqual([
      { label: 'notes.list.today', count: 1 },
      { label: 'June', count: 1 },
      { label: '2023', count: 1 },
    ]);
  });

  // The day after a fall-back transition runs 25 hours, so a "yesterday" cutoff built by
  // subtracting 86_400_000 from today's midnight lands an hour PAST yesterday's midnight and files
  // that whole day under the month instead. Walking a year catches it wherever the runtime's zone
  // puts its transitions; under a fixed-offset zone this still guards the calendar arithmetic.
  it('calls the previous calendar day yesterday on every day of the year', () => {
    for (let offset = 0; offset < 366; offset += 1) {
      const today = new Date(2026, 0, 1 + offset, 12);
      const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 9);
      const [first] = groupNotesByDate([yesterday], date => date, today, 'en', t);
      expect(first?.label, yesterday.toDateString()).toBe('common.time.yesterday');
    }
  });

  it('returns no groups for an empty list', () => {
    expect(group([])).toEqual([]);
  });
});
