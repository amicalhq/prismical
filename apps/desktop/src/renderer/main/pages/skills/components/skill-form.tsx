import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { IconDotsVertical } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/trpc/react";
import type { ArtifactMode, Skill, SkillConfig } from "@/db/schema";
import { DeleteSkillDialog } from "./delete-skill-dialog";

type SurfaceKey = "dock" | "inline";

interface Props {
  mode: "new" | "edit";
  existing?: Skill;
}

function triggerDownload(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function SkillForm({ mode, existing }: Props) {
  const navigate = useNavigate();
  const utils = api.useUtils();

  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [editingOptions, setEditingOptions] = useState<ArtifactMode>(
    existing?.config.editingOptions ?? "append-section",
  );
  const [surfaces, setSurfaces] = useState<Set<SurfaceKey>>(
    new Set((existing?.config.surface ?? ["dock"]) as SurfaceKey[]),
  );
  const [defaultSkill, setDefaultSkill] = useState(
    existing?.config.defaultSkill ?? false,
  );
  const [modeAgnosticPrompt, setModeAgnosticPrompt] = useState(
    existing?.config.modeAgnosticPrompt ?? false,
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);

  const isReadOnly = mode === "edit" && existing?.system === true;

  const create = api.skills.create.useMutation({
    onSuccess: async () => {
      await utils.skills.list.invalidate();
      navigate({ to: "/settings/skills" });
    },
    onError: (err) => setError(err.message),
  });

  const update = api.skills.update.useMutation({
    onSuccess: async () => {
      await utils.skills.list.invalidate();
      navigate({ to: "/settings/skills" });
    },
    onError: (err) => setError(err.message),
  });

  const clone = api.skills.clone.useMutation({
    onSuccess: async (cloned) => {
      await utils.skills.list.invalidate();
      navigate({
        to: "/settings/skills/$skillId",
        params: { skillId: cloned.id },
      });
    },
    onError: (err) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim().length === 0) {
      setError("Name is required");
      return;
    }
    if (body.trim().length === 0) {
      setError("Body is required");
      return;
    }
    if (surfaces.size === 0) {
      setError("At least one surface must be selected");
      return;
    }
    const config: SkillConfig = {
      editingOptions,
      surface: [...surfaces],
      defaultSkill,
      modeAgnosticPrompt,
    };
    if (mode === "new") {
      create.mutate({
        slug: autoSlug(name),
        name: name.trim(),
        description: description.trim() || null,
        body,
        config,
      });
    } else if (existing) {
      update.mutate({
        id: existing.id,
        name: name.trim(),
        description: description.trim() || null,
        body,
        config,
        enabled,
      });
    }
  };

  function autoSlug(n: string) {
    return n
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64);
  }

  const handleExportJson = async () => {
    if (!existing) return;
    const result = await utils.skills.exportAsJson.fetch({ id: existing.id });
    triggerDownload(
      JSON.stringify(result.json, null, 2),
      `${existing.slug}.json`,
      "application/json",
    );
  };

  const handleExportMarkdown = async () => {
    if (!existing) return;
    const result = await utils.skills.exportAsMarkdown.fetch({
      id: existing.id,
    });
    triggerDownload(result.markdown, `${existing.slug}.md`, "text/markdown");
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="max-w-5xl mx-auto p-8 space-y-6"
    >
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold truncate">
          {mode === "new" ? "New skill" : (existing?.name ?? "Skill")}
        </h1>
        {mode === "edit" && existing ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More options">
                <IconDotsVertical size={18} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => clone.mutate({ id: existing.id })}
                disabled={clone.isPending}
              >
                Clone skill
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleExportJson}>
                Export as JSON
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleExportMarkdown}>
                Export as Markdown
              </DropdownMenuItem>
              {!existing.system ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setPendingDelete(true)}
                  >
                    Delete skill
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {isReadOnly ? (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900 dark:bg-yellow-950 dark:border-yellow-900 dark:text-yellow-100">
          This is a system skill — read-only. Duplicate to customize.
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={isReadOnly}
          maxLength={80}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description" className="text-muted-foreground">
          Description
        </Label>
        <Input
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={isReadOnly}
          placeholder="One short line shown on the skill card"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="body" className="text-base font-medium">
          Prompt
        </Label>
        <Textarea
          id="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          className="font-mono min-h-[280px]"
          placeholder="You are the &ldquo;…&rdquo; skill. The note (and any linked transcript) is provided as markdown in the system prompt &mdash; transform it and emit clean markdown back."
          disabled={isReadOnly}
        />
      </div>

      <details className="rounded-lg border bg-card open:p-4 [&:not([open])]:p-3 [&:not([open])>summary]:m-0">
        <summary className="cursor-pointer select-none text-sm font-medium text-muted-foreground">
          Advanced settings
        </summary>
        <div className="mt-4 space-y-5">
          <div className="space-y-2">
            <Label>Mode</Label>
            <RadioGroup
              value={editingOptions}
              onValueChange={(v) => setEditingOptions(v as ArtifactMode)}
              disabled={isReadOnly}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="append-section" id="m-as" />
                <Label htmlFor="m-as">Append section</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="replace-doc" id="m-rd" />
                <Label htmlFor="m-rd">Replace document</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="inline-rewrite" id="m-ir" />
                <Label htmlFor="m-ir">Inline rewrite</Label>
              </div>
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label>Surfaces</Label>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="s-dock"
                  checked={surfaces.has("dock")}
                  onCheckedChange={(c) =>
                    setSurfaces((prev) => toggleSet(prev, "dock", c === true))
                  }
                  disabled={isReadOnly}
                />
                <Label htmlFor="s-dock">Dock</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="s-inline"
                  checked={surfaces.has("inline")}
                  onCheckedChange={(c) =>
                    setSurfaces((prev) => toggleSet(prev, "inline", c === true))
                  }
                  disabled={isReadOnly}
                />
                <Label htmlFor="s-inline">Inline (highlight popover)</Label>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="default">Set as default sparkle target</Label>
            <Switch
              id="default"
              checked={defaultSkill}
              onCheckedChange={setDefaultSkill}
              disabled={isReadOnly}
            />
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="mode-agnostic"
              checked={modeAgnosticPrompt}
              onCheckedChange={(c) => setModeAgnosticPrompt(c === true)}
              disabled={isReadOnly}
              className="mt-0.5"
            />
            <div className="space-y-1">
              <Label htmlFor="mode-agnostic" className="font-normal">
                Mode-agnostic prompt
              </Label>
              <p className="text-xs text-muted-foreground">
                Don&rsquo;t tell the model which mode is active — the body alone
                describes the output. Lets the user switch between append and
                replace after the run without re-generating. Inline-rewrite is
                always mode-tuned regardless of this setting.
              </p>
            </div>
          </div>

          {mode === "edit" && !existing?.system ? (
            <div className="flex items-center justify-between">
              <Label htmlFor="enabled">Enabled</Label>
              <Switch
                id="enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>
          ) : null}
        </div>
      </details>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          disabled={isReadOnly || create.isPending || update.isPending}
        >
          {mode === "new" ? "Create" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => navigate({ to: "/settings/skills" })}
        >
          Cancel
        </Button>
      </div>

      <DeleteSkillDialog
        skill={pendingDelete && existing ? existing : null}
        onCancel={() => setPendingDelete(false)}
        onDeleted={() => navigate({ to: "/settings/skills" })}
      />
    </form>
  );
}

function toggleSet<T>(s: Set<T>, key: T, on: boolean): Set<T> {
  const next = new Set(s);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}
