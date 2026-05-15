"use client";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import {
  PROVIDER_TYPE_CONFIG_FIELDS,
  type InstanceConfigFieldName,
  type InstanceConfigFieldSpec,
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
  supportsStrictJsonSchema: "Endpoint supports strict JSON Schema",
};

const FIELD_PLACEHOLDERS: Partial<Record<InstanceConfigFieldName, string>> = {
  apiKey: "sk-...",
  url: "http://localhost:11434",
  baseURL: "https://api.example.com/v1",
};

const FIELD_HELP_TEXT: Partial<Record<InstanceConfigFieldName, string>> = {
  supportsStrictJsonSchema:
    "Only enable if your endpoint supports OpenAI's strict structured outputs (response_format: json_schema). vLLM, LM Studio 0.3+, Mistral, and Ollama support this; most generic proxies do not. If unsure, leave off — skills still work via JSON mode.",
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
  // Field values carry strings for text/password fields, booleans for
  // checkbox fields. Stored under one keyed map so resetting on
  // open/edit stays simple.
  const [values, setValues] = useState<Record<string, string | boolean>>({});
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
      const next: Record<string, string | boolean> = {};
      for (const f of fields) {
        const v = cfg[f.field];
        if (f.inputType === "checkbox") {
          next[f.field] = typeof v === "boolean" ? v : false;
        } else {
          next[f.field] = typeof v === "string" ? v : "";
        }
      }
      setValues(next);
    }
  }, [open, mode, existingQuery.data, fields]);

  const validateMutation = api.instances.validate.useMutation();
  const createMutation = api.instances.create.useMutation();
  const updateMutation = api.instances.update.useMutation();

  const buildConfig = (): Record<string, string | boolean> => {
    const cfg: Record<string, string | boolean> = {};
    for (const f of fields) {
      const v = values[f.field];
      if (f.inputType === "checkbox") {
        // Send the boolean — even `false` matters because it disambiguates
        // "user explicitly disabled" from "field never set". Validation
        // (instances.ts) accepts both undefined and boolean.
        if (typeof v === "boolean") cfg[f.field] = v;
      } else if (typeof v === "string" && v.trim()) {
        cfg[f.field] = v.trim();
      }
    }
    return cfg;
  };

  const requiredFilled = fields
    .filter((f) => f.required)
    .every((f) => {
      const v = values[f.field];
      return typeof v === "string" && v.trim().length > 0;
    });
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

          {fields.filter((f) => !f.advanced).map((f) =>
            renderField(f, values, setValues),
          )}

          {fields.some((f) => f.advanced) && (
            <Collapsible className="space-y-2">
              <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/40">
                Advanced settings
                <ChevronDown className="h-3 w-3 transition-transform data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 pt-2">
                {fields
                  .filter((f) => f.advanced)
                  .map((f) => renderField(f, values, setValues))}
              </CollapsibleContent>
            </Collapsible>
          )}

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

function renderField(
  f: InstanceConfigFieldSpec,
  values: Record<string, string | boolean>,
  setValues: React.Dispatch<
    React.SetStateAction<Record<string, string | boolean>>
  >,
) {
  if (f.inputType === "checkbox") {
    const checked = values[f.field] === true;
    return (
      <div key={f.field} className="space-y-2">
        <div className="flex items-start gap-2">
          <Checkbox
            id={`instance-${f.field}`}
            checked={checked}
            onCheckedChange={(v) =>
              setValues((prev) => ({ ...prev, [f.field]: v === true }))
            }
          />
          <Label
            htmlFor={`instance-${f.field}`}
            className="text-sm font-normal leading-snug"
          >
            {FIELD_LABELS[f.field]}
          </Label>
        </div>
        {FIELD_HELP_TEXT[f.field] && (
          <p className="text-xs text-muted-foreground pl-6">
            {FIELD_HELP_TEXT[f.field]}
          </p>
        )}
      </div>
    );
  }

  const stringValue =
    typeof values[f.field] === "string" ? (values[f.field] as string) : "";
  return (
    <div key={f.field} className="space-y-2">
      <Label htmlFor={`instance-${f.field}`}>
        {FIELD_LABELS[f.field]}
        {f.required && <span className="text-destructive"> *</span>}
      </Label>
      <Input
        id={`instance-${f.field}`}
        type={f.inputType}
        placeholder={FIELD_PLACEHOLDERS[f.field]}
        value={stringValue}
        onChange={(e) =>
          setValues((prev) => ({ ...prev, [f.field]: e.target.value }))
        }
      />
    </div>
  );
}
