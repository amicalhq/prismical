'use client';

import { lazy, Suspense, useState } from 'react';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

const EmojiPickerContent = lazy(() => import('./note-emoji-picker-content'));

interface NoteEmojiPickerProps {
  value?: string;
  disabled?: boolean;
  onChange: (emoji: string | undefined) => void;
}

export function NoteEmojiPicker({ value, disabled, onChange }: NoteEmojiPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const select = (emoji: string | undefined) => {
    onChange(emoji);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          className="mt-1 size-10 shrink-0 p-0 hover:bg-accent"
          aria-label={t('notes.actions.changeEmoji')}
          disabled={disabled}
        >
          {value ? (
            <span className="text-[28px] leading-none">{value}</span>
          ) : (
            <FileText className="size-6 text-muted-foreground" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[296px] max-w-[calc(100vw-1rem)] overflow-hidden p-0"
        aria-label={t('notes.pickEmoji')}
      >
        <Suspense
          fallback={
            <div role="status" className="flex h-80 items-center justify-center text-sm text-muted-foreground">
              {t('common.status.loading')}
            </div>
          }
        >
          <EmojiPickerContent onSelect={select} />
        </Suspense>
        {value && (
          <div className="border-t p-1">
            <Button variant="ghost" size="sm" className="w-full" onClick={() => select(undefined)}>
              {t('common.actions.remove')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
