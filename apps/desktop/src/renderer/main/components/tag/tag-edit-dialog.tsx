import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { HexColorInput, HexColorPicker } from "react-colorful";
import {
  TAG_PRESETS,
  isValidHex,
  normalizeHex,
} from "@/renderer/main/lib/tag-colors";
import { TagChip } from "./tag-chip";
import { TagHash } from "./tag-hash";
import { api } from "@/trpc/react";
import type { Tag } from "@/db/schema";

interface TagEditDialogProps {
  tag: Tag;
  noteCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const NAME_RE = /^[a-z0-9_-]{1,32}$/;

export function TagEditDialog({
  tag,
  noteCount,
  open,
  onOpenChange,
}: TagEditDialogProps) {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const nameId = useId();
  const colorId = useId();
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setName(tag.name);
      setColor(tag.color);
    }
  }, [open, tag]);

  const lcName = name.trim().toLowerCase();
  const nameValid = NAME_RE.test(lcName);
  const colorValid = isValidHex(color);
  const showGhost = nameValid && lcName !== name;

  const allTagsQ = api.tags.list.useQuery({ sortBy: "name" });
  const duplicateTag = useMemo(() => {
    if (!nameValid || lcName === tag.name) return undefined;
    return (allTagsQ.data ?? []).find(
      (other) => other.name === lcName && other.id !== tag.id,
    );
  }, [allTagsQ.data, lcName, nameValid, tag.id, tag.name]);

  const update = api.tags.update.useMutation({
    onSuccess: () => {
      utils.tags.invalidate();
      utils.notes.getNotes.invalidate();
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(
        t("settings.tags.errors.updateFailed", { message: error.message }),
      );
    },
  });
  const del = api.tags.delete.useMutation({
    onSuccess: () => {
      utils.tags.invalidate();
      utils.notes.getNotes.invalidate();
      setConfirmDelete(false);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(
        t("settings.tags.errors.deleteFailed", { message: error.message }),
      );
    },
  });

  const previewName = lcName || t("settings.tags.editDialog.previewName");
  const canSave =
    nameValid && colorValid && !duplicateTag && !update.isPending;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settings.tags.editDialog.title")}</DialogTitle>
          </DialogHeader>

          <label
            htmlFor={nameId}
            className="text-xs uppercase tracking-wider text-muted-foreground"
          >
            {t("settings.tags.editDialog.nameLabel")}
          </label>
          <div className="relative">
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!nameValid || !!duplicateTag}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {showGhost && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground"
              >
                #{lcName}
              </span>
            )}
          </div>
          {!nameValid && (
            <p className="text-xs text-destructive">
              {t("settings.tags.editDialog.nameError")}
            </p>
          )}
          {nameValid && duplicateTag && (
            <p className="text-xs text-destructive">
              {t("settings.tags.editDialog.nameDuplicate", { name: lcName })}
            </p>
          )}

          <div
            id={colorId}
            className="mt-3 text-xs uppercase tracking-wider text-muted-foreground"
          >
            {t("settings.tags.editDialog.colorLabel")}
          </div>
          <div role="group" aria-labelledby={colorId} className="grid grid-cols-8 gap-2">
            {TAG_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={t("settings.tags.editDialog.pickColorAria", {
                  color: c,
                })}
                onClick={() => setColor(c)}
                className={`h-8 w-8 rounded-md border-2 ${
                  color === c ? "border-foreground" : "border-transparent"
                }`}
                style={{ background: c }}
              />
            ))}
            <Popover open={customOpen} onOpenChange={setCustomOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t("settings.tags.editDialog.customColorAria")}
                  className={`h-8 w-8 rounded-md border-2 ${
                    !TAG_PRESETS.includes(color as (typeof TAG_PRESETS)[number])
                      ? "border-foreground"
                      : "border-transparent"
                  }`}
                  style={{
                    background:
                      "conic-gradient(from 0deg, #ef4444, #f59e0b, #eab308, #22c55e, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)",
                  }}
                />
              </PopoverTrigger>
              <PopoverContent className="w-56 p-3">
                <HexColorPicker
                  color={color}
                  onChange={(c) => setColor(c.toLowerCase())}
                />
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-mono text-sm">#</span>
                  <HexColorInput
                    color={color.replace(/^#/, "")}
                    onChange={(c) => {
                      const n = normalizeHex("#" + c);
                      if (n) setColor(n);
                    }}
                    className="flex-1 rounded border bg-background px-2 py-1 font-mono text-sm"
                  />
                </div>
              </PopoverContent>
            </Popover>
          </div>

          <div className="mt-3 text-xs uppercase tracking-wider text-muted-foreground">
            {t("settings.tags.editDialog.previewLabel")}
          </div>
          <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-2">
            <TagHash color={colorValid ? color : "#888"} name={previewName} />
            <span className="ml-auto" />
            <TagChip color={colorValid ? color : "#888"} name={previewName} />
          </div>

          <DialogFooter className="mt-4">
            <Button
              variant="destructive"
              className="mr-auto"
              onClick={() => setConfirmDelete(true)}
            >
              {t("settings.tags.editDialog.delete")}
            </Button>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("settings.tags.editDialog.cancel")}
            </Button>
            <Button
              onClick={() => {
                const nameChanged = lcName !== tag.name;
                const colorChanged = color !== tag.color;
                if (!nameChanged && !colorChanged) {
                  onOpenChange(false);
                  return;
                }
                update.mutate({
                  id: tag.id,
                  ...(nameChanged ? { name: lcName } : {}),
                  ...(colorChanged ? { color } : {}),
                });
              }}
              disabled={!canSave}
            >
              {t("settings.tags.editDialog.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.tags.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.tags.deleteConfirmDescription", {
                count: noteCount,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.tags.editDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => del.mutate({ id: tag.id })}
              className="bg-destructive text-foreground hover:bg-destructive/90"
            >
              {t("settings.tags.menu.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
