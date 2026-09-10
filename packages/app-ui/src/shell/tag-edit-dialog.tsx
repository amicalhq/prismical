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
// picker is the shared curated palette — deliberately NOT a free color input: a tag's color paints
// the `#` glyph directly on both the light and the dark surface, and an arbitrary pick (white, or
// near-black) leaves the chip invisible on one of them. A color outside the palette (a legacy oklch
// seed) is shown as an extra leading swatch so it stays visible and selected rather than looking
// unset.
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

  // Reseed only when a DIFFERENT tag is opened — keyed on id, not the live object. If the tags
  // query refetches mid-edit (e.g. a window-focus refetch), `tag` gets a new object identity but the
  // same id, so we must NOT reseed and clobber what the user is typing.
  React.useEffect(() => {
    if (tag) {
      setName(tag.name);
      setColor(tag.color);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag?.id]);

  // Compare colors case-INSENSITIVELY. The palette is lowercase, but `tag.color` is free-form text
  // end to end (the column and the `/v1` schema both take any string), so a tag colored `#F59E0B`
  // through the public API must still light up the amber swatch instead of reading as a stray color.
  const sameColor = (a: string, b: string) =>
    (normalizeHexColor(a) ?? a) === (normalizeHexColor(b) ?? b);

  const original = { name: tag?.name ?? '', color: tag?.color ?? '' };
  const nameChanged = name !== original.name;
  const colorChanged = !sameColor(color, original.color);
  // Only the changed name is validated — an untouched (possibly legacy) name is always allowed.
  const nameInvalid = nameChanged && !isValidTagName(name);
  const submitDisabled = pending || nameInvalid || (!nameChanged && !colorChanged);

  // Show the current color as its own leading swatch when it's not one of the presets, so a legacy
  // color stays selectable and visible rather than appearing unselected. That makes the grid 21
  // cells for such a tag; every other tag fills two even rows of 10.
  const swatches: string[] = TAG_PRESETS.some(c => sameColor(c, color))
    ? [...TAG_PRESETS]
    : [color, ...TAG_PRESETS];

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
            {/* Explicit 10 columns, not flex-wrap: the palette is 20 presets, so the
                grid fills two even rows and keeps its shape whatever the dialog
                width does. Adding or removing a preset means keeping the total a
                multiple of 10 — there's a test on that. */}
            <div className="grid grid-cols-10 gap-2">
              {swatches.map(c => {
                const selected = sameColor(c, color);
                return (
                  <button
                    key={c}
                    type="button"
                    aria-label={t('dialogs.tag.useColor', { color: c })}
                    aria-pressed={selected}
                    onClick={() => setColor(c)}
                    className={cn(
                      'flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-[box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected && 'ring-2 ring-ring'
                    )}
                    style={{ backgroundColor: c }}
                  >
                    {selected && <Check className="size-4" style={{ color: swatchInk(c) }} />}
                  </button>
                );
              })}
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
