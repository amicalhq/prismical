import type {
  CalendarConnection,
  CalendarEvent,
  Folder,
  Note,
  Skill,
  SkillConfig,
  Tag,
  VocabularyEntry,
  Instance,
} from '@prismical/app-contracts';

// ─── Core wire shapes (only the fields we read) ──────────────────────────────
export interface CoreNote {
  id: string;
  titleSource?: string;
  titleRevision?: number;
  title?: string | null;
  iconUrl?: string | null;
  starred?: boolean;
  folderId?: string | null;
  eventId?: string | null;
  updatedAt: string;
  contentText?: string | null; // body; markdown with ?includeBody=1, else absent
  excerpt?: string | null; // plaintext body preview (first 100 chars), always present on the list
  canWrite?: boolean; // per-note writability (omitted ⇒ treat as writable)
  isOwner?: boolean; // false ⇒ shared with the caller (drives "Shared with me")
  sharedByName?: string | null; // the note author's name
}
export interface CoreFolder {
  id: string;
  name: string;
  parentId?: string | null;
  isFavorite?: boolean;
  createdAt: string;
}
export interface CoreTag {
  id: string;
  name: string;
  color: string;
  isFavorite?: boolean;
  createdAt: string;
}
export interface CoreSkill {
  id: string;
  name: string;
  description?: string | null;
  body?: string | null;
  system?: boolean;
  config: SkillConfig;
  createdAt: string;
  updatedAt: string;
  enabled?: boolean;
  allowedTools?: string[] | null;
}
export interface CoreVocabulary {
  id: string;
  word: string;
  replacementWord?: string | null;
  isReplacement?: boolean;
  usageCount?: number;
  updatedAt: string;
}
export interface CoreInstance {
  id: string;
  provider: string;
  label: string;
  config: Record<string, unknown>;
}
export interface CoreNoteTag {
  noteId: string;
  tagId: string;
}

// ─── emoji ↔ iconUrl (assumption: emoji char stored directly in iconUrl) ─────
export function emojiFromIconUrl(iconUrl: string | null | undefined): string | undefined {
  if (!iconUrl) return undefined;
  // A bare (non-URL) string is treated as a literal emoji.
  if (/^https?:\/\//.test(iconUrl)) return undefined;
  return iconUrl;
}
export function iconUrlFromEmoji(emoji: string | undefined): string | null {
  return emoji && emoji.length > 0 ? emoji : null;
}

function previewFrom(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 140);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

// ─── core → UI ───────────────────────────────────────────────────────────────
export function toNote(c: CoreNote, tagIds: string[] = []): Note {
  // `body` is the markdown snapshot when fetched with includeBody — good for
  // copy/export. The preview must stay PLAINTEXT, so derive it from the list's `excerpt`
  // (plaintext, always present) rather than the markdown body; fall back to body if absent.
  const body = c.contentText ?? '';
  return {
    id: c.id,
    title: c.title ?? '',
    titleSource: c.titleSource ?? 'manual',
    titleRevision: c.titleRevision ?? 0,
    emoji: emojiFromIconUrl(c.iconUrl),
    starred: Boolean(c.starred),
    folderId: c.folderId ?? undefined,
    tagIds,
    updatedAt: c.updatedAt,
    preview: previewFrom(c.excerpt ?? body),
    body,
    eventId: c.eventId ?? undefined,
    writable: c.canWrite ?? true,
    isOwner: c.isOwner ?? true,
    sharedByName: c.sharedByName ?? undefined,
  };
}

export function toFolder(c: CoreFolder): Folder {
  return {
    id: c.id,
    name: c.name,
    parentId: c.parentId ?? null,
    createdAt: c.createdAt,
    favorite: Boolean(c.isFavorite),
  };
}

export function toTag(c: CoreTag): Tag {
  return {
    id: c.id,
    name: c.name,
    color: c.color,
    createdAt: c.createdAt,
    favorite: Boolean(c.isFavorite),
  };
}

export function toSkill(c: CoreSkill, enabled: boolean): Skill {
  // Normalize the config jsonb to a complete SkillConfig — live skills (esp.
  // system skills) may carry a partial/empty config, so consumers can't assume
  // `surface` is an array or the flags exist.
  const cfg = (c.config ?? {}) as Partial<SkillConfig>;
  return {
    id: c.id,
    slug: slugify(c.name) || c.id,
    name: c.name,
    description: c.description ?? '',
    body: c.body ?? '',
    system: Boolean(c.system),
    enabled,
    config: {
      outputTarget: cfg.outputTarget ?? 'note-body',
      inputs: { transcript: cfg.inputs?.transcript === true },
      editingOptions: cfg.editingOptions ?? 'append-section',
      surface: Array.isArray(cfg.surface) ? cfg.surface : [],
      defaultSkill: Boolean(cfg.defaultSkill),
      modeAgnosticPrompt: Boolean(cfg.modeAgnosticPrompt),
      askScope: cfg.askScope === 'single-note' ? 'single-note' : 'multi-note',
    },
    allowedTools: Array.isArray(c.allowedTools) ? c.allowedTools : null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function toVocabulary(c: CoreVocabulary): VocabularyEntry {
  return {
    id: c.id,
    word: c.word,
    replacement: c.replacementWord ?? undefined,
    addedAt: c.updatedAt,
    uses: c.usageCount ?? 0,
  };
}

export function toInstance(c: CoreInstance): Instance {
  return {
    id: c.id,
    provider: c.provider as Instance['provider'],
    label: c.label,
    config: c.config as Instance['config'],
    catalog: [],
  };
}

// ─── Calendar (read-only ingestion output) ───────────────────────────────────
export interface CoreConnection {
  id: string;
  provider: string;
  status: string;
  statusReason?: string | null;
  syncMode?: 'pull' | 'device_push' | null;
  accountEmail?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
  lastSyncedAt?: string | null;
}
export interface CoreCalendar {
  id: string;
  connectionId: string;
  name: string;
  color?: string | null;
  primary?: boolean;
  enabled?: boolean;
  hidden?: boolean;
  updatedAt: string;
}
export interface CoreEvent {
  id: string;
  calendarId: string;
  title: string;
  startsAt?: string | null;
  endsAt?: string | null;
  isAllDay?: boolean;
  status?: string;
  meetingUrl?: string | null;
  location?: string | null;
  attendees?: unknown;
  updatedAt: string;
}

export function toConnection(c: CoreConnection): CalendarConnection {
  return {
    id: c.id,
    provider: c.provider,
    syncMode: c.syncMode ?? undefined,
    status: c.status,
    statusReason: c.statusReason ?? undefined,
    accountEmail: c.accountEmail ?? undefined,
    deviceId: c.deviceId ?? undefined,
    deviceName: c.deviceName ?? undefined,
    lastSyncedAt: c.lastSyncedAt ?? undefined,
  };
}

const DEFAULT_CALENDAR_COLOR = '#6366f1';

/** `event.attendees` carries the provider's raw attendee entries (Google shape). */
interface RawAttendee {
  email?: string;
  displayName?: string;
  name?: string;
  resource?: boolean;
}

function attendeeNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const names = raw
    .filter((a): a is RawAttendee => typeof a === 'object' && a !== null)
    .filter(a => !a.resource) // skip meeting rooms / equipment
    .map(a => a.displayName || a.name || a.email || '')
    .filter(Boolean);
  return names.length > 0 ? names : undefined;
}

/** Returns null for events without a usable start time (the UI groups by day). */
export function toCalendarEvent(c: CoreEvent, calendarColor?: string | null): CalendarEvent | null {
  if (!c.startsAt) return null;
  return {
    id: c.id,
    title: c.title || '(untitled)',
    start: c.startsAt,
    end: c.endsAt ?? c.startsAt,
    calendarColor: calendarColor || DEFAULT_CALENDAR_COLOR,
    isAllDay: Boolean(c.isAllDay),
    joinUrl: c.meetingUrl ?? undefined,
    attendees: attendeeNames(c.attendees),
  };
}

// ─── UI → core (write bodies) ────────────────────────────────────────────────
export interface NotePatch {
  title?: string;
  starred?: boolean;
  emoji?: string | undefined;
  folderId?: string | undefined;
}
/**
 * Map a UI patch to core's note write body. IMPORTANT: key PRESENCE means
 * "intend to write this field" — an omitted key leaves the field untouched,
 * while a present key with a cleared value (emoji/folderId `undefined`) writes
 * NULL (verified against core's partial `.set` engine). Callers MUST build the
 * patch with ONLY the keys they intend to change — never pre-seed the object
 * with `undefined` values (e.g. via object spread), or you will silently null
 * the folder/emoji.
 */
export function noteUpdateBody(patch: NotePatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if ('title' in patch) body.title = patch.title;
  if ('starred' in patch) body.starred = patch.starred;
  if ('emoji' in patch) body.iconUrl = iconUrlFromEmoji(patch.emoji);
  if ('folderId' in patch) body.folderId = patch.folderId ?? null;
  return body;
}
