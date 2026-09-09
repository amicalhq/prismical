import {
  Blocks,
  Brain,
  CreditCard,
  AudioLines,
  BookText,
  CalendarDays,
  CircleUser,
  HardDrive,
  House,
  Info,
  Keyboard,
  KeyRound,
  type LucideIcon,
  NotebookText,
  Settings,
  SlidersHorizontal,
  Users,
  Wand2,
} from 'lucide-react';
import type { ShortcutId } from '../lib/shortcuts';
import { useTranslation } from 'react-i18next';

// Mirrors the desktop `settings-navigation.ts`. The web app uses lucide icons
// (the desktop uses @tabler/icons-react), mapped to the closest equivalents.

export interface SidebarNavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  /** Registry id of the shortcut hint chip to render (lib/shortcuts.ts owns the
   *  combo and its display form; shell/nav-shortcuts.tsx binds it). */
  shortcut?: ShortcutId;
  description?: string;
  /** Colocated aliases for Settings sidebar search. These extend the canonical
   * nav entry without creating a second list that can drift. */
  searchTerms?: readonly string[];
  /** Feature flag (`useFeatureFlag` key) the entry is shown under. Unset ⇒
   *  always shown. The sidebar reads it; screens still gate themselves. */
  feature?: string;
}

// Primary (app) navigation shown in the sidebar header. The trailing item —
// Settings (→ Preferences) — is split out by the sidebar so it sits below the
// command search + Home/Notes.
interface SidebarNavDefinition extends Omit<SidebarNavItem, 'title' | 'description'> {
  titleKey: string;
  descriptionKey?: string;
}

const HOME_NAV_DEFINITIONS: SidebarNavDefinition[] = [
  { titleKey: 'navigation.pages.home', url: '/home', icon: House, shortcut: 'go-home' },
  { titleKey: 'navigation.pages.notes', url: '/notes', icon: NotebookText },
  {
    titleKey: 'navigation.pages.settings',
    url: '/settings/preferences',
    icon: Settings,
    shortcut: 'go-settings',
  },
];

// The settings-mode navigation list (shown when the sidebar flips into settings
// mode). Order and labels match the desktop `SETTINGS_NAV_ITEMS`.
const SETTINGS_NAV_DEFINITIONS: SidebarNavDefinition[] = [
  {
    titleKey: 'navigation.settingsSections.preferences.title',
    url: '/settings/preferences',
    icon: Settings,
    descriptionKey: 'navigation.settingsSections.preferences.description',
    searchTerms: ['appearance', 'dark mode', 'light mode', 'dock', 'permissions'],
  },
  // Organization membership. Shown on both platforms — the screen is ports-based
  // and desktop's router mounts the route.
  {
    titleKey: 'navigation.settingsSections.members.title',
    url: '/settings/members',
    icon: Users,
    feature: 'organization',
    descriptionKey: 'navigation.settingsSections.members.description',
    searchTerms: ['team', 'invite', 'roles', 'public sharing'],
  },
  // Web-first section (no desktop counterpart yet): personal account + deletion.
  {
    titleKey: 'navigation.settingsSections.account.title',
    url: '/settings/account',
    icon: CircleUser,
    feature: 'account',
    descriptionKey: 'navigation.settingsSections.account.description',
    searchTerms: ['email', 'sign in'],
  },
  {
    titleKey: 'navigation.settingsSections.billing.title',
    url: '/settings/billing',
    icon: CreditCard,
    feature: 'billing',
    descriptionKey: 'navigation.settingsSections.billing.description',
    searchTerms: ['pricing', 'subscription', 'payment', 'invoice'],
  },
  {
    titleKey: 'navigation.settingsSections.transcription.title',
    url: '/settings/transcription',
    icon: AudioLines,
    descriptionKey: 'navigation.settingsSections.transcription.description',
    searchTerms: ['dictation', 'microphone', 'recording', 'speech', 'language'],
  },
  // Desktop-only (gated in app-sidebar on the 'local-models' capability): the
  // on-device whisper model manager. The screen itself is
  // desktop-owned; only this nav entry lives in the shared list.
  {
    titleKey: 'navigation.settingsSections.localModels.title',
    url: '/settings/local-models',
    icon: HardDrive,
    descriptionKey: 'navigation.settingsSections.localModels.description',
    searchTerms: ['whisper', 'offline', 'on-device', 'download', 'transcription'],
  },
  {
    titleKey: 'navigation.settingsSections.shortcuts.title',
    url: '/settings/shortcuts',
    icon: Keyboard,
    descriptionKey: 'navigation.settingsSections.shortcuts.description',
    searchTerms: ['hotkeys', 'dock shortcut'],
  },
  {
    titleKey: 'navigation.settingsSections.vocabulary.title',
    url: '/settings/vocabulary',
    icon: BookText,
    descriptionKey: 'navigation.settingsSections.vocabulary.description',
    searchTerms: ['custom words', 'replacement', 'dictionary', 'transcription'],
  },
  // Web-first section (no desktop counterpart yet): calendar account connections.
  {
    titleKey: 'navigation.settingsSections.calendar.title',
    url: '/settings/calendar',
    icon: CalendarDays,
    feature: 'calendar',
    descriptionKey: 'navigation.settingsSections.calendar.description',
    searchTerms: ['events', 'meetings', 'google calendar', 'apple calendar'],
  },
  {
    titleKey: 'navigation.settingsSections.aiModels.title',
    url: '/settings/ai-models',
    icon: Brain,
    descriptionKey: 'navigation.settingsSections.aiModels.description',
    searchTerms: ['providers', 'openai', 'openrouter', 'gemini', 'text generation'],
  },
  {
    titleKey: 'navigation.settingsSections.skills.title',
    url: '/settings/skills',
    icon: Wand2,
    descriptionKey: 'navigation.settingsSections.skills.description',
    searchTerms: ['prompts', 'enhance', 'ai actions'],
  },
  // Web-first section (no desktop counterpart yet): integrations and self-serve public API keys.
  {
    titleKey: 'navigation.settingsSections.integrations.title',
    url: '/settings/integrations',
    icon: Blocks,
    feature: 'automations',
    descriptionKey: 'navigation.settingsSections.integrations.description',
    searchTerms: ['connections', 'zapier', 'webhooks', 'automations'],
  },
  {
    titleKey: 'navigation.settingsSections.apiMcp.title',
    url: '/settings/api-keys',
    icon: KeyRound,
    feature: 'publicApi',
    descriptionKey: 'navigation.settingsSections.apiMcp.description',
    searchTerms: ['developer', 'claude', 'cursor', 'codex'],
  },
  {
    titleKey: 'navigation.settingsSections.advanced.title',
    url: '/settings/advanced',
    icon: SlidersHorizontal,
    descriptionKey: 'navigation.settingsSections.advanced.description',
    searchTerms: ['logs', 'diagnostics', 'reset', 'debug', 'troubleshooting'],
  },
  {
    titleKey: 'navigation.settingsSections.about.title',
    url: '/settings/about',
    icon: Info,
    descriptionKey: 'navigation.settingsSections.about.description',
    searchTerms: ['updates', 'changelog', 'support', 'contact'],
  },
];

function useLocalizedNavItems(definitions: readonly SidebarNavDefinition[]): SidebarNavItem[] {
  const { t } = useTranslation();
  return definitions.map(({ titleKey, descriptionKey, ...item }) => ({
    ...item,
    title: t(titleKey as never),
    description: descriptionKey ? t(descriptionKey as never) : undefined,
  }));
}

export function useHomeNavItems(): SidebarNavItem[] {
  return useLocalizedNavItems(HOME_NAV_DEFINITIONS);
}

export function useSettingsNavItems(): SidebarNavItem[] {
  return useLocalizedNavItems(SETTINGS_NAV_DEFINITIONS);
}
