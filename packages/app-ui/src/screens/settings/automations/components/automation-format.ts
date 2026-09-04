import { AudioLines, FilePlus2, FolderInput, Tag as TagIcon, type LucideIcon } from 'lucide-react';
import type { Automation, AutomationEventType } from '@prismical/app-client';
import type { Folder, Tag } from '@prismical/app-contracts';
import type { ApplicationTFunction } from '@prismical/app-i18n';

/** UI labels for the V1 event catalog (order = builder dropdown order). */
export const EVENT_TYPE_OPTIONS: AutomationEventType[] = [
  'recording.transcribed',
  'note.created',
  'note.added_to_folder',
  'note.tag_added',
];

export function eventTypeLabel(type: string, t: ApplicationTFunction): string {
  switch (type) {
    case 'recording.transcribed':
      return t('settings.automations.events.recordingTranscribed');
    case 'note.created':
      return t('settings.automations.events.noteCreated');
    case 'note.added_to_folder':
      return t('settings.automations.events.noteAddedToFolder');
    case 'note.tag_added':
      return t('settings.automations.events.tagAddedToNote');
    case 'delivery':
      return t('settings.automations.events.delivery');
    default:
      return type;
  }
}

/**
 * Row icon is DERIVED from the trigger event type (deterministic, no user choice in V1):
 * mic = recording transcribed · folder = added to folder · tag = tag added · file = created.
 */
export function automationIcon(a: Pick<Automation, 'triggerConfig'>): LucideIcon {
  const first = a.triggerConfig?.eventTypes?.[0];
  switch (first) {
    case 'recording.transcribed':
      return AudioLines;
    case 'note.added_to_folder':
      return FolderInput;
    case 'note.tag_added':
      return TagIcon;
    default:
      return FilePlus2;
  }
}

export function webhookHost(a: Pick<Automation, 'actionConfig'>): string {
  try {
    return new URL(a.actionConfig.url).host;
  } catch {
    return a.actionConfig?.url ?? '';
  }
}

/**
 * One human-readable line per automation: "When a recording is transcribed in Sales calls →
 * send to hooks.zapier.com". Folder/tag names resolve client-side; unknown ids degrade to a
 * count ("2 folders") rather than leaking ids.
 */
export function automationSentence(
  a: Automation,
  folders: Folder[],
  tags: Tag[],
  t: ApplicationTFunction,
  locale: string
): string {
  const types = a.triggerConfig?.eventTypes ?? [];
  const list = new Intl.ListFormat(locale, { style: 'long', type: 'disjunction' });
  const when = list.format(types.map(type => eventTypeLabel(type, t)));

  const parts: string[] = [t('settings.automations.sentence.trigger', { events: when })];
  const filter = a.triggerConfig?.filter;
  if (filter?.folderIds?.length) {
    const names = filter.folderIds.map(id => folders.find(f => f.id === id)?.name).filter(Boolean);
    const count = filter.folderIds.length;
    parts.push(
      t('settings.automations.sentence.folderScope', {
        folders: names.length
          ? new Intl.ListFormat(locale).format(names as string[])
          : t('settings.automations.sentence.folderCount', {
              count,
              countLabel: count.toLocaleString(locale),
            }),
      })
    );
  }
  if (filter?.tagIds?.length) {
    const names = filter.tagIds.map(id => tags.find(t => t.id === id)?.name).filter(Boolean);
    const count = filter.tagIds.length;
    parts.push(
      t('settings.automations.sentence.tagScope', {
        tags: names.length
          ? new Intl.ListFormat(locale).format(names.map(name => `#${name}`) as string[])
          : t('settings.automations.sentence.tagCount', {
              count,
              countLabel: count.toLocaleString(locale),
            }),
      })
    );
  }
  return t('settings.automations.sentence.destination', {
    trigger: parts.join(' '),
    host: webhookHost(a),
  });
}

/** Compact relative time ("12 min ago", "just now") without a date library. */
export function timeAgo(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (ms < 45_000) return relative.format(0, 'second');
  const min = Math.round(ms / 60_000);
  if (min < 60) return relative.format(-min, 'minute');
  const h = Math.round(min / 60);
  if (h < 24) return relative.format(-h, 'hour');
  const d = Math.round(h / 24);
  return relative.format(-d, 'day');
}

/** How soon a pending retry fires ("in 4 min"). */
export function timeUntil(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (ms <= 0) return relative.format(0, 'second');
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return relative.format(min, 'minute');
  return relative.format(Math.round(min / 60), 'hour');
}
