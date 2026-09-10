'use client';

import * as React from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { cn } from '../lib/utils';
import { TAG_PRESETS, normalizeHexColor, swatchInk } from '@prismical/app-client';
import { isValidTagName, sanitizeTagNameInput } from '../lib/tag-name';
import type { Tag } from '@prismical/app-contracts';
import { useTranslation } from 'react-i18next';

interface TagEditDialogProps {
  /** The tag being edited; the dialog is open while this is non-null. */
  tag: Tag | null;
  onOpenChange: (open: boolean) => void;
  pending?: boolean;
  /** Called with only the fields that actually changed. Parent owns the mutation + closes. */
  onSubmit: (patch: { name?: string; color?: string }) => void;
}

// Rename + recolor a tag. Name enforces the web charset inline (letters/numbers only). The color
// picker is the shared desktop palette plus a custom slot: the native color input and a hex field
// both write the same value, so any color is reachable. A color outside the palette (a custom pick,
// or a legacy oklch seed) shows as the fill of the custom swatch, so it stays visible and selected
// rather than looking unset.
export function TagEditDialog({
  tag,
  onOpenChange,
  pending = false,
  onSubmit,
}: TagEditDialogProps) {
  const { t } = useTranslation();
  const nameId = React.useId();
  // Seed the name RAW (not sanitized): a legacy tag name with `-`/`_` must survive an untouched
  // edit — we only send `name` in the patch when it actually changes (see below), so a pure
  // recolor never re-normalizes the name.
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState<string>(TAG_PRESETS[0]);
  // What the hex field shows. Kept separate from `color` so a half-typed value ("#ab") doesn't
  // recolor anything, and so a non-hex legacy color can leave the field empty without clearing it.
  const [hexDraft, setHexDraft] = React.useState('');

  // Reseed only when a DIFFERENT tag is opened — keyed on id, not the live object. If the tags
  // query refetches mid-edit (e.g. a window-focus refetch), `tag` gets a new object identity but the
  // same id, so we must NOT reseed and clobber what the user is typing.
  React.useEffect(() => {
    if (tag) {
      setName(tag.name);
      setColor(tag.color);
      setHexDraft(normalizeHexColor(tag.color) ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag?.id]);

  const original = { name: tag?.name ?? '', color: tag?.color ?? '' };
  const nameChanged = name !== original.name;
  const colorChanged = color !== original.color;
  // Only the changed name is validated — an untouched (possibly legacy) name is always allowed.
  const nameInvalid = nameChanged && !isValidTagName(name);
  const submitDisabled = pending || nameInvalid || (!nameChanged && !colorChanged);

  const isPreset = (TAG_PRESETS as readonly string[]).includes(color);
  // The native <input type="color"> only accepts 6-digit hex, so a legacy oklch color opens the
  // picker on black — the tag keeps its color until the user actually picks one.
  const pickerValue = normalizeHexColor(color) ?? '#000000';

  const applyColor = (next: string) => {
    const normalized = normalizeHexColor(next) ?? next;
    setColor(normalized);
    setHexDraft(normalizeHexColor(normalized) ?? '');
  };

  // Commit only a complete hex value; anything shorter is still being typed.
  const handleHexChange = (value: string) => {
    const cleaned = `#${value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6)}`;
    setHexDraft(cleaned);
    if (cleaned.length === 7) setColor(cleaned.toLowerCase());
  };

  // Accept the 3-digit shorthand on blur, and snap an unfinished value back to the live color.
  const handleHexBlur = () => {
    const normalized = normalizeHexColor(hexDraft);
    if (normalized) applyColor(normalized);
    else setHexDraft(normalizeHexColor(color) ?? '');
  };

  const handleSubmit = () => {
    if (submitDisabled) return;
    onSubmit({
      ...(nameChanged ? { name } : {}),
      ...(colorChanged ? { color } : {}),
    });
  };

  return (
    <Dialog open={tag !== null} onOpenChange={next => !pending && onOpenChange(next)}>
      {/* Sized to the swatch grid below: 10 columns of size-7 with gap-2 is
          10*28 + 9*8 = 352px, plus the dialog's own 24px padding either side.
          At the default sm:max-w-lg the grid had room for 13 per row, so the
          20 swatches broke 13 + 7 and the second row trailed off half-empty. */}
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t('dialogs.tag.title')}</DialogTitle>
          <DialogDescription>{t('dialogs.tag.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={nameId}>{t('common.fields.name')}</Label>
            <Input
              id={nameId}
              autoFocus
              maxLength={50}
              aria-describedby={`${nameId}-hint`}
              value={name}
              // Inline-enforce the charset as the user types (strips disallowed keystrokes).
              onChange={e => setName(sanitizeTagNameInput(e.target.value))}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSubmit();
              }}
            />
            <p id={`${nameId}-hint`} className="text-2xs text-muted-foreground">
              {t('dialogs.tag.lettersNumbersOnly')}
            </p>
          </div>
          <div className="space-y-2">
            <Label>{t('common.fields.color')}</Label>
            {/* Explicit 10 columns, not flex-wrap: 19 presets plus the custom
                swatch is exactly 20, so the grid fills two even rows and stays
                even if the dialog is resized. Adding or removing a preset means
                keeping the total a multiple of 10. */}
            <div className="grid grid-cols-10 gap-2">
              {TAG_PRESETS.map(c => (
                <button
                  key={c}
                  type="button"
                  aria-label={t('dialogs.tag.useColor', { color: c })}
                  aria-pressed={c === color}
                  onClick={() => applyColor(c)}
                  className={cn(
                    'flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-[box-shadow]',
                    c === color && 'ring-2 ring-ring'
                  )}
                  style={{ backgroundColor: c }}
                >
                  {c === color && <Check className="size-4" style={{ color: swatchInk(c) }} />}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 pt-1">
              {/* The native picker sits invisibly on top of the swatch so the OS color panel
                  anchors to it; the swatch itself shows the rainbow until a custom color is
                  chosen, then the color. */}
              <span
                className={cn(
                  'relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full ring-offset-2 ring-offset-background transition-[box-shadow]',
                  !isPreset && 'ring-2 ring-ring'
                )}
                style={
                  isPreset
                    ? {
                        background:
                          'conic-gradient(#ef4444, #facc15, #4ade80, #22d3ee, #60a5fa, #c084fc, #f472b6, #ef4444)',
                      }
                    : { backgroundColor: color }
                }
              >
                {!isPreset && <Check className="size-4" style={{ color: swatchInk(color) }} />}
                <input
                  type="color"
                  aria-label={t('dialogs.tag.customColor')}
                  value={pickerValue}
                  onChange={e => applyColor(e.target.value)}
                  className="absolute inset-0 size-full cursor-pointer opacity-0"
                />
              </span>
              <Input
                aria-label={t('dialogs.tag.hexColor')}
                value={hexDraft}
                maxLength={7}
                spellCheck={false}
                placeholder="#000000"
                onChange={e => handleHexChange(e.target.value)}
                onBlur={handleHexBlur}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSubmit();
                }}
                className="h-8 w-28 font-mono text-xs"
              />
            </div>
          </div>
        </div>
        <DialogFooter className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('common.actions.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitDisabled}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('common.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
