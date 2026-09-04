import { describe, expect, it, vi } from 'vitest';
import type { EventKitEvent } from '../../src/main/infra/eventkit/client';

vi.mock('electron', async () => (await import('../helpers/fake-electron')).createFakeElectron());

const { chunkEventKitEvents } = await import('../../src/main/domains/eventkit/live');

function event(index: number, description = ''): EventKitEvent {
  return {
    calendarExternalId: 'calendar-1',
    sourceEventId: `event-${index}`,
    icalUid: `ical-${index}`,
    recurrenceId: 'single',
    title: `Event ${index}`,
    description,
    startsAt: '2026-07-28T12:00:00.000Z',
    endsAt: '2026-07-28T12:30:00.000Z',
    isAllDay: false,
    status: 'confirmed',
    meetingUrl: null,
    location: null,
    organizer: null,
    attendees: null,
    sourceUpdatedAt: null,
  };
}

describe('EventKit snapshot chunking', () => {
  it('sends one empty chunk for an authoritative empty snapshot', () => {
    expect(chunkEventKitEvents([])).toEqual([[]]);
  });

  it('caps a chunk at 200 events', () => {
    const chunks = chunkEventKitEvents(Array.from({ length: 201 }, (_, index) => event(index)));
    expect(chunks.map(chunk => chunk.length)).toEqual([200, 1]);
  });

  it('splits on encoded bytes before Fastify body parsing', () => {
    const description = 'x'.repeat(20_000);
    const chunks = chunkEventKitEvents(
      Array.from({ length: 30 }, (_, index) => event(index, description))
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify({ events: chunk }), 'utf8')).toBeLessThanOrEqual(
        450 * 1024
      );
    }
  });
});
