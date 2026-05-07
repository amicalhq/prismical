import { useEffect, useState } from "react";
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
  const utils = api.useUtils();
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

  const update = api.tags.update.useMutation({
    onSuccess: () => {
      utils.tags.invalidate();
      utils.notes.getNotes.invalidate();
      onOpenChange(false);
    },
  });
  const del = api.tags.delete.useMutation({
    onSuccess: () => {
      utils.tags.invalidate();
      utils.notes.getNotes.invalidate();
      setConfirmDelete(false);
      onOpenChange(false);
    },
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit tag</DialogTitle>
          </DialogHeader>

          <label className="text-xs uppercase tracking-wider text-muted-foreground">
            Name
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!nameValid}
          />
          {!nameValid && (
            <p className="text-xs text-destructive">
              Use lowercase letters, digits, '-' or '_' (max 32 chars).
            </p>
          )}

          <label className="mt-3 text-xs uppercase tracking-wider text-muted-foreground">
            Color
          </label>
          <div className="grid grid-cols-8 gap-2">
            {TAG_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Pick ${c}`}
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
                  aria-label="Custom color"
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

          <label className="mt-3 text-xs uppercase tracking-wider text-muted-foreground">
            Preview
          </label>
          <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-2">
            <TagHash
              color={colorValid ? color : "#888"}
              name={lcName || "tag"}
            />
            <span className="ml-auto" />
            <TagChip
              color={colorValid ? color : "#888"}
              name={lcName || "tag"}
            />
          </div>

          <DialogFooter className="mt-4">
            <Button
              variant="destructive"
              className="mr-auto"
              onClick={() => setConfirmDelete(true)}
            >
              Delete tag
            </Button>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                update.mutate({ id: tag.id, name: lcName, color })
              }
              disabled={!nameValid || !colorValid || update.isPending}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete tag?</AlertDialogTitle>
            <AlertDialogDescription>
              This tag will be removed from {noteCount} note
              {noteCount === 1 ? "" : "s"}. The notes themselves are not
              affected. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => del.mutate({ id: tag.id })}
              className="bg-destructive text-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
