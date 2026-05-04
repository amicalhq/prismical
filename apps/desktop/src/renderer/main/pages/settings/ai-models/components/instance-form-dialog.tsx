"use client";
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import {
  PROVIDER_TYPE_CONFIG_FIELDS,
  type InstanceConfigFieldName,
  type ProviderType,
} from "@/constants/provider-types";
import { PROVIDER_META } from "@/renderer/main/components/provider-meta";

type Mode =
  | { kind: "create"; provider: ProviderType }
  | { kind: "edit"; id: string };

interface InstanceFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode | null;
}

const FIELD_LABELS: Record<InstanceConfigFieldName, string> = {
  apiKey: "API key",
  url: "URL",
  baseURL: "Base URL",
};

const FIELD_PLACEHOLDERS: Record<InstanceConfigFieldName, string> = {
  apiKey: "sk-...",
  url: "http://localhost:11434",
  baseURL: "https://api.example.com/v1",
};

export default function InstanceFormDialog({
  open,
  onOpenChange,
  mode,
}: InstanceFormDialogProps) {
  const utils = api.useUtils();

  // For edit mode, fetch the current instance.
  const editingId = mode?.kind === "edit" ? mode.id : undefined;
  const existingQuery = api.instances.get.useQuery(
    { id: editingId ?? "" },
    { enabled: !!editingId },
  );

  const provider: ProviderType | null = useMemo(() => {
    if (mode?.kind === "create") return mode.provider;
    if (existingQuery.data) return existingQuery.data.provider as ProviderType;
    return null;
  }, [mode, existingQuery.data]);

  const fields = useMemo(
    () => (provider ? PROVIDER_TYPE_CONFIG_FIELDS[provider] : []),
    [provider],
  );

  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Reset form on open / mode change.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (mode?.kind === "create") {
      setLabel("");
      setValues({});
    } else if (existingQuery.data) {
      setLabel(existingQuery.data.label);
      const cfg = existingQuery.data.config as Record<string, unknown>;
      const next: Record<string, string> = {};
      for (const f of fields) {
        const v = cfg[f.field];
        next[f.field] = typeof v === "string" ? v : "";
      }
      setValues(next);
    }
  }, [open, mode, existingQuery.data, fields]);

  const validateMutation = api.instances.validate.useMutation();
  const createMutation = api.instances.create.useMutation();
  const updateMutation = api.instances.update.useMutation();

  const buildConfig = (): Record<string, string> => {
    const cfg: Record<string, string> = {};
    for (const f of fields) {
      const v = (values[f.field] ?? "").trim();
      if (v) cfg[f.field] = v;
    }
    return cfg;
  };

  const requiredFilled = fields
    .filter((f) => f.required)
    .every((f) => (values[f.field] ?? "").trim().length > 0);
  const labelFilled = label.trim().length > 0;
  const canSubmit =
    provider !== null && labelFilled && requiredFilled && !isSaving;

  const handleSave = async () => {
    if (!provider) return;
    setIsSaving(true);
    setError(null);
    const config = buildConfig();
    try {
      const validation = await validateMutation.mutateAsync({
        provider,
        config,
      });
      if (!validation.success) {
        setError(validation.error ?? "Validation failed");
        return;
      }

      if (mode?.kind === "create") {
        await createMutation.mutateAsync({
          provider,
          label: label.trim(),
          config,
        });
        toast.success(`${PROVIDER_META[provider].label} instance created`);
      } else if (mode?.kind === "edit") {
        await updateMutation.mutateAsync({
          id: mode.id,
          label: label.trim(),
          config,
        });
        toast.success("Instance updated");
      }

      utils.instances.list.invalidate();
      utils.instances.listByProvider.invalidate();
      // After an edit, the picker's per-instance catalog may be cached
      // against stale credentials — force a refetch so the user sees
      // the newly-validated key reflected in the dropdown immediately.
      if (mode?.kind === "edit") {
        utils.instances.fetchCatalog.invalidate({ id: mode.id });
      }
      onOpenChange(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  if (!provider) {
    // Edit mode is loading the instance; render an empty dialog while we wait.
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Loading…</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const meta = PROVIDER_META[provider];
  const isEditing = mode?.kind === "edit";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <meta.Logo className={`size-5 ${meta.tint ?? ""}`} />
            {isEditing ? `Edit ${meta.label}` : `Add ${meta.label}`}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the connection details for this instance."
              : `Connect a new ${meta.label} instance. The credentials are validated before being saved.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="instance-label">Label</Label>
            <Input
              id="instance-label"
              type="text"
              placeholder={`Personal ${meta.label}`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus={!isEditing}
            />
          </div>

          {fields.map((f) => (
            <div key={f.field} className="space-y-2">
              <Label htmlFor={`instance-${f.field}`}>
                {FIELD_LABELS[f.field]}
                {f.required && <span className="text-destructive"> *</span>}
              </Label>
              <Input
                id={`instance-${f.field}`}
                type={f.inputType}
                placeholder={FIELD_PLACEHOLDERS[f.field]}
                value={values[f.field] ?? ""}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [f.field]: e.target.value }))
                }
              />
            </div>
          ))}

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSubmit}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Validating…
              </>
            ) : isEditing ? (
              "Save"
            ) : (
              "Add"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
