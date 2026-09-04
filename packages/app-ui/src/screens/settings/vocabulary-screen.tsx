"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Plus, Edit, Trash2, Info, MoveRight, Loader2 } from "lucide-react";
import { Button } from "../../ui/button";
import { Card, CardContent } from "../../ui/card";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Switch } from "../../ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../ui/tooltip";
import { DataError } from "../../components/data-error";
import { ListRowsSkeleton } from "../../components/skeletons";
import {
  useVocabulary,
  useAddVocabulary,
  useUpdateVocabulary,
  useDeleteVocabulary,
  useTeamVocabulary,
  useAddTeamVocabulary,
  useUpdateTeamVocabulary,
  useDeleteTeamVocabulary,
  useActiveOrg,
  useFeatureFlag,
} from "@prismical/app-client";
import type { VocabularyEntry } from "@prismical/app-contracts";

type FormData = { word: string; replacement: string; isReplacement: boolean };

/** Which list a dialog is acting on — personal words or the org-wide team list. */
type Scope = "personal" | "team";

const EMPTY_FORM: FormData = { word: "", replacement: "", isReplacement: false };

const ORG_MANAGER_ROLES = new Set(["owner", "admin"]);

// Add/Edit dialog — a "Replacement" toggle flips between a single-word form and
// a word → replacement form. Mirrors the desktop `VocabularyDialog`.
function VocabularyDialog({
  open,
  onOpenChange,
  mode,
  scope,
  formData,
  onFormDataChange,
  onSubmit,
  pending = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "add" | "edit";
  scope: Scope;
  formData: FormData;
  onFormDataChange: (data: FormData) => void;
  onSubmit: () => void;
  pending?: boolean;
}) {
  const { t } = useTranslation();
  const submitDisabled =
    pending ||
    !formData.word.trim() ||
    (formData.isReplacement && !formData.replacement.trim());

  const title =
    scope === "team"
      ? mode === "add"
        ? t("settings.vocabulary.dialog.addTeamTitle")
        : t("settings.vocabulary.dialog.editTeamTitle")
      : mode === "add"
        ? t("settings.vocabulary.dialog.addPersonalTitle")
        : t("settings.vocabulary.dialog.editPersonalTitle");

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Label htmlFor="replacement-toggle">
                {t("settings.vocabulary.form.replacement")}
              </Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info
                      className="h-4 w-4 text-muted-foreground"
                      aria-label={t("settings.vocabulary.form.replacementHelp")}
                    />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-center">
                    {t("settings.vocabulary.form.replacementHelp")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Switch
              id="replacement-toggle"
              checked={formData.isReplacement}
              onCheckedChange={(checked) =>
                onFormDataChange({ ...formData, isReplacement: checked })
              }
            />
          </div>

          {formData.isReplacement ? (
            <div className="flex items-center gap-2">
              <Input
                placeholder={t("settings.vocabulary.form.misheardAs")}
                value={formData.word}
                onChange={(e) =>
                  onFormDataChange({ ...formData, word: e.target.value })
                }
              />
              <span className="text-muted-foreground" aria-hidden="true">
                →
              </span>
              <Input
                placeholder={t("settings.vocabulary.form.correctSpelling")}
                value={formData.replacement}
                onChange={(e) =>
                  onFormDataChange({ ...formData, replacement: e.target.value })
                }
              />
            </div>
          ) : (
            <Input
              placeholder={t("settings.vocabulary.form.newWord")}
              value={formData.word}
              onChange={(e) =>
                onFormDataChange({ ...formData, word: e.target.value })
              }
            />
          )}

          <DialogFooter className="flex justify-end gap-2 pt-4">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button onClick={onSubmit} disabled={submitDisabled}>
              {pending && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {mode === "add"
                ? t("settings.vocabulary.actions.addWord")
                : t("settings.vocabulary.actions.saveChanges")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Delete confirmation — mirrors the desktop `DeleteDialog`.
function DeleteDialog({
  open,
  onOpenChange,
  deletingItem,
  scope,
  onConfirm,
  pending = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deletingItem: VocabularyEntry | null;
  scope: Scope;
  onConfirm: () => void;
  pending?: boolean;
}) {
  const { t } = useTranslation();
  const preview = deletingItem?.replacement
    ? `${deletingItem.word} → ${deletingItem.replacement}`
    : deletingItem?.word;

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.vocabulary.delete.title")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t(
            scope === "team"
              ? "settings.vocabulary.delete.teamDescription"
              : "settings.vocabulary.delete.personalDescription",
            { entry: preview ?? "" },
          )}
        </p>
        <DialogFooter className="flex justify-end gap-2 pt-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {pending
              ? t("common.status.deleting")
              : t("common.actions.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One card of vocabulary rows. Read-only (no per-row controls) when `onEdit` is omitted. */
function VocabularyList({
  items,
  isLoading,
  error,
  onRetry,
  onEdit,
  onDelete,
  errorMessage,
  emptyMessage,
}: {
  items: VocabularyEntry[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  onEdit?: (item: VocabularyEntry) => void;
  onDelete?: (item: VocabularyEntry) => void;
  errorMessage: string;
  emptyMessage: string;
}) {
  const { t } = useTranslation();
  return (
    <Card className="overflow-clip p-0">
      <CardContent className="p-0">
        {isLoading ? (
          <ListRowsSkeleton />
        ) : error ? (
          <DataError className="border-0" message={errorMessage} onRetry={onRetry} />
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          <div className="space-y-0">
            {items.map((item, index) => (
              <div className="transition-colors hover:bg-accent" key={item.id}>
                <div className="group flex items-center justify-between px-4 py-3">
                  <span className="flex items-center gap-1 text-sm">
                    {item.replacement ? (
                      <>
                        <span>{item.word}</span>
                        <MoveRight
                          className="mx-2 h-4 w-4 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span>{item.replacement}</span>
                      </>
                    ) : (
                      item.word
                    )}
                  </span>
                  {onEdit && onDelete && (
                    <div className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onEdit(item)}
                        aria-label={t("settings.vocabulary.actions.editAria", {
                          word: item.word,
                        })}
                      >
                        <Edit className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onDelete(item)}
                        aria-label={t("settings.vocabulary.actions.deleteAria", {
                          word: item.word,
                        })}
                      >
                        <Trash2
                          className="h-4 w-4 text-destructive"
                          aria-hidden="true"
                        />
                      </Button>
                    </div>
                  )}
                </div>
                {index < items.length - 1 && (
                  <div className="border-t border-border" />
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function VocabularyScreen() {
  const { t } = useTranslation();
  const vocabularyQuery = useVocabulary();
  const { data: items = [], isLoading } = vocabularyQuery;
  const addMutation = useAddVocabulary();
  const updateMutation = useUpdateVocabulary();
  const deleteMutation = useDeleteVocabulary();

  // Team list: readable by every member (the words apply to everyone's transcription), writable
  // only by owners/admins. The role check here just hides controls — core enforces the 403.
  const teamQuery = useTeamVocabulary();
  const { data: teamItems = [], isLoading: teamLoading } = teamQuery;
  const teamAddMutation = useAddTeamVocabulary();
  const teamUpdateMutation = useUpdateTeamVocabulary();
  const teamDeleteMutation = useDeleteTeamVocabulary();
  const activeOrg = useActiveOrg();
  const canManageTeam = ORG_MANAGER_ROLES.has(activeOrg?.role ?? "");
  // No team without the organization feature (the desktop local workspace).
  const { enabled: organizationEnabled } = useFeatureFlag("organization");

  const [isAddOpen, setIsAddOpen] = React.useState(false);
  const [isEditOpen, setIsEditOpen] = React.useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = React.useState(false);
  // Which list the open dialog is acting on — one set of dialogs serves both sections.
  const [scope, setScope] = React.useState<Scope>("personal");
  const [editingItem, setEditingItem] = React.useState<VocabularyEntry | null>(
    null,
  );
  const [deletingItem, setDeletingItem] = React.useState<VocabularyEntry | null>(
    null,
  );
  const [formData, setFormData] = React.useState<FormData>(EMPTY_FORM);

  const isTeam = scope === "team";
  const activeAdd = isTeam ? teamAddMutation : addMutation;
  const activeUpdate = isTeam ? teamUpdateMutation : updateMutation;
  const activeDelete = isTeam ? teamDeleteMutation : deleteMutation;

  const openAdd = (next: Scope) => {
    setScope(next);
    setFormData(EMPTY_FORM);
    setIsAddOpen(true);
  };

  const openEdit = (next: Scope) => (item: VocabularyEntry) => {
    setScope(next);
    setEditingItem(item);
    setFormData({
      word: item.word,
      replacement: item.replacement ?? "",
      isReplacement: !!item.replacement,
    });
    setIsEditOpen(true);
  };

  const openDelete = (next: Scope) => (item: VocabularyEntry) => {
    setScope(next);
    setDeletingItem(item);
    setIsDeleteOpen(true);
  };

  /** The write payload both add and edit send — trims, and drops the replacement when off. */
  const writeBody = () => ({
    word: formData.word.trim(),
    replacementWord: formData.isReplacement
      ? formData.replacement.trim() || null
      : null,
    isReplacement: formData.isReplacement,
  });

  const handleAdd = () => {
    activeAdd.mutate(writeBody(), { onSuccess: () => setIsAddOpen(false) });
  };

  const handleEdit = () => {
    if (!editingItem) return;
    activeUpdate.mutate(
      { id: editingItem.id, patch: writeBody() },
      {
        onSuccess: () => {
          setEditingItem(null);
          setIsEditOpen(false);
        },
      },
    );
  };

  const handleDelete = () => {
    if (!deletingItem) return;
    activeDelete.mutate(deletingItem.id, {
      onSuccess: () => {
        setDeletingItem(null);
        setIsDeleteOpen(false);
      },
    });
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-xl font-bold">
          {t("settings.vocabulary.screen.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.vocabulary.screen.description")}
        </p>
      </div>

      {/* Personal */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">
            {t("settings.vocabulary.personal.title")}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("settings.vocabulary.personal.description")}
          </p>
        </div>
        <Button
          onClick={() => openAdd("personal")}
          className="flex items-center gap-2"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("settings.vocabulary.actions.addWord")}
        </Button>
      </div>
      <VocabularyList
        items={items}
        isLoading={isLoading}
        error={vocabularyQuery.error}
        onRetry={() => void vocabularyQuery.refetch()}
        onEdit={openEdit("personal")}
        onDelete={openDelete("personal")}
        errorMessage={t("settings.vocabulary.personal.loadError")}
        emptyMessage={t("settings.vocabulary.personal.empty")}
      />

      {/* Team */}
      {organizationEnabled && (
        <>
          <div className="mt-10 mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">
                {t("settings.vocabulary.team.title")}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {canManageTeam
                  ? t("settings.vocabulary.team.description")
                  : t("settings.vocabulary.team.descriptionReadonly")}
              </p>
            </div>
            {canManageTeam && (
              <Button
                variant="outline"
                onClick={() => openAdd("team")}
                className="flex items-center gap-2"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("settings.vocabulary.actions.addTeamWord")}
              </Button>
            )}
          </div>
          <VocabularyList
            items={teamItems}
            isLoading={teamLoading}
            error={teamQuery.error}
            onRetry={() => void teamQuery.refetch()}
            onEdit={canManageTeam ? openEdit("team") : undefined}
            onDelete={canManageTeam ? openDelete("team") : undefined}
            errorMessage={t("settings.vocabulary.team.loadError")}
            emptyMessage={
              canManageTeam
                ? t("settings.vocabulary.team.empty")
                : t("settings.vocabulary.team.emptyReadonly")
            }
          />
        </>
      )}

      <VocabularyDialog
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        mode="add"
        scope={scope}
        formData={formData}
        onFormDataChange={setFormData}
        onSubmit={handleAdd}
        pending={activeAdd.isPending}
      />
      <VocabularyDialog
        open={isEditOpen}
        onOpenChange={setIsEditOpen}
        mode="edit"
        scope={scope}
        formData={formData}
        onFormDataChange={setFormData}
        onSubmit={handleEdit}
        pending={activeUpdate.isPending}
      />
      <DeleteDialog
        open={isDeleteOpen}
        onOpenChange={setIsDeleteOpen}
        deletingItem={deletingItem}
        scope={scope}
        onConfirm={handleDelete}
        pending={activeDelete.isPending}
      />
    </div>
  );
}
