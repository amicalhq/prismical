'use client';

import {
  EmojiPicker,
  type EmojiPickerListCategoryHeaderProps,
  type EmojiPickerListEmojiProps,
  type EmojiPickerListRowProps,
  type Locale,
} from 'frimousse';
import { useTranslation } from 'react-i18next';
import { matchSupportedLocale } from '@prismical/app-i18n';

const locales: Record<string, Locale> = {
  en: 'en',
  de: 'de',
  es: 'es',
  ja: 'ja',
  'zh-TW': 'zh-hant',
};

const components = {
  CategoryHeader: ({ category, ...props }: EmojiPickerListCategoryHeaderProps) => (
    <div {...props} className="bg-popover px-3 pb-1.5 pt-3 text-xs font-medium text-muted-foreground">
      {category.label}
    </div>
  ),
  Row: ({ children, ...props }: EmojiPickerListRowProps) => (
    <div {...props} className="scroll-my-1.5 px-2">
      {children}
    </div>
  ),
  Emoji: ({ emoji, ...props }: EmojiPickerListEmojiProps) => (
    <button
      {...props}
      type="button"
      className="flex size-[34px] items-center justify-center rounded-md text-2xl data-[active]:bg-accent"
    >
      {emoji.emoji}
    </button>
  ),
};

export default function NoteEmojiPickerContent({ onSelect }: { onSelect: (emoji: string) => void }) {
  const { t, i18n } = useTranslation();
  const locale = locales[matchSupportedLocale(i18n.resolvedLanguage ?? i18n.language) ?? 'en'];

  return (
    <EmojiPicker.Root
      columns={8}
      locale={locale}
      emojibaseUrl="https://cdn.jsdelivr.net/npm/emojibase-data@17.0.0"
      onEmojiSelect={({ emoji }) => onSelect(emoji)}
      className="isolate flex h-[360px] max-h-[calc(var(--radix-popover-content-available-height)-44px)] w-full flex-col"
    >
      <EmojiPicker.Search
        autoFocus
        aria-label={t('notes.emojiPicker.search')}
        placeholder={t('notes.emojiPicker.search')}
        className="mx-2 mb-1 mt-2 h-9 shrink-0 rounded-md border border-input bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
      <EmojiPicker.Viewport className="relative min-h-0 flex-1 outline-hidden">
        <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {t('common.status.loading')}
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {t('notes.emojiPicker.empty')}
        </EmojiPicker.Empty>
        <EmojiPicker.List components={components} className="select-none pb-2" />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  );
}
