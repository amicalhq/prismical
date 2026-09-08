'use client';

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureFlags, useNavigation } from '@prismical/app-client';
import { MoreVertical } from 'lucide-react';
import { Button } from '../../../../ui/button';
import { Input } from '../../../../ui/input';
import { Label } from '../../../../ui/label';
import { Textarea } from '../../../../ui/textarea';
import { Switch } from '../../../../ui/switch';
import { RadioGroup, RadioGroupItem } from '../../../../ui/radio-group';
import { Checkbox } from '../../../../ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../../ui/dropdown-menu';
import type { ArtifactMode, Skill, SkillAskScope, SkillSurface } from '@prismical/app-contracts';
import { cn } from '../../../../lib/utils';
import { skillDisplayDescription, skillDisplayName } from '../../../../lib/skill-presentation';
import { useSkills } from './skills-store';
import { skillToMarkdown } from '../skill-file';

// The two Ask-AI scopes, shown as a card picker when the Ask AI surface is enabled.
const ASK_SCOPE_OPTIONS: SkillAskScope[] = ['single-note', 'multi-note'];
import { DeleteSkillDialog } from './delete-skill-dialog';
import { SkillToolsPicker } from './skill-tools-picker';

interface SkillFormProps {
  mode: 'new' | 'edit';
  existing?: Skill;
}

// Trigger a client-side file download (used by Export as JSON / Markdown).
function triggerDownload(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toggleSet<T>(s: Set<T>, key: T, on: boolean): Set<T> {
  const next = new Set(s);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

/** Custom skill editor with experimental controls limited to opted-in accounts. */
export function SkillForm({ mode, existing }: SkillFormProps) {
  const { t } = useTranslation();
  const router = useNavigation();
  const { isEnabled } = useFeatureFlags();
  const advancedEnabled = isEnabled('skillAdvancedSettings');
  const toolsEnabled = isEnabled('integrations') && isEnabled('skillMcpTools');
  const { create, update, remove, clone } = useSkills();

  const [name, setName] = React.useState(existing?.name ?? '');
  const [description, setDescription] = React.useState(existing?.description ?? '');
  const [body, setBody] = React.useState(existing?.body ?? '');
  const [outputTarget, setOutputTarget] = React.useState<'note-body' | 'note-title'>(
    existing?.config.outputTarget ?? 'note-body'
  );
  const [includeTranscript, setIncludeTranscript] = React.useState(
    existing?.config.inputs?.transcript ?? false
  );
  const [editingOptions, setEditingOptions] = React.useState<ArtifactMode>(
    existing?.config.editingOptions ?? 'append-section'
  );
  const [surfaces, setSurfaces] = React.useState<Set<SkillSurface>>(
    new Set<SkillSurface>(existing?.config.surface ?? ['dock'])
  );
  const [defaultSkill, setDefaultSkill] = React.useState(existing?.config.defaultSkill ?? false);
  const [modeAgnosticPrompt, setModeAgnosticPrompt] = React.useState(
    existing?.config.modeAgnosticPrompt ?? false
  );
  const [askScope, setAskScope] = React.useState<SkillAskScope>(
    existing?.config.askScope ?? 'multi-note'
  );
  const [enabled, setEnabled] = React.useState(existing?.enabled ?? true);
  // MCP tool grants — [] renders as "no tools", saved as null.
  const [allowedTools, setAllowedTools] = React.useState<string[]>(existing?.allowedTools ?? []);
  const [error, setError] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const isReadOnly = mode === 'edit' && existing?.system === true;

  const effectiveOutputTarget = advancedEnabled
    ? outputTarget
    : (existing?.config.outputTarget ?? 'note-body');
  const restrictedMode =
    !advancedEnabled &&
    (effectiveOutputTarget === 'note-title' ||
      existing?.config.editingOptions === 'inline-rewrite');
  const config = {
    ...existing?.config,
    outputTarget: effectiveOutputTarget,
    inputs: { ...existing?.config.inputs, transcript: includeTranscript },
    editingOptions: !advancedEnabled && (restrictedMode || editingOptions === 'inline-rewrite')
      ? (existing?.config.editingOptions ?? 'append-section')
      : editingOptions,
    surface: !advancedEnabled
      ? (existing?.config.surface ?? (['dock'] as SkillSurface[]))
      : outputTarget === 'note-title'
        ? (['title', 'dock'] as SkillSurface[])
        : [...surfaces].filter(surface => surface !== 'title'),
    defaultSkill: !advancedEnabled
      ? (existing?.config.defaultSkill ?? false)
      : outputTarget === 'note-title'
        ? false
        : defaultSkill,
    modeAgnosticPrompt: advancedEnabled
      ? modeAgnosticPrompt
      : (existing?.config.modeAgnosticPrompt ?? false),
    askScope: advancedEnabled ? askScope : (existing?.config.askScope ?? 'multi-note'),
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim().length === 0) {
      setError(t('settings.skillLibrary.errors.nameRequired'));
      return;
    }
    if (body.trim().length === 0) {
      setError(t('settings.skillLibrary.errors.promptRequired'));
      return;
    }
    if (advancedEnabled && config.surface.length === 0) {
      setError(t('settings.skillLibrary.errors.surfaceRequired'));
      return;
    }
    setIsSaving(true);
    let allowedToolsForSave = existing?.allowedTools ?? null;
    if (advancedEnabled && effectiveOutputTarget === 'note-title') {
      allowedToolsForSave = null;
    } else if (toolsEnabled && effectiveOutputTarget !== 'note-title') {
      allowedToolsForSave = allowedTools.length ? allowedTools : null;
    }
    try {
      if (mode === 'new') {
        const created = await create({
          name: name.trim(),
          description: description.trim(),
          body,
          config,
          enabled,
          allowedTools: allowedToolsForSave,
        });
        router.push(`/settings/skills/${created.id}`);
      } else if (existing) {
        await update(existing.id, {
          name: name.trim(),
          description: description.trim(),
          body,
          config,
          enabled,
          allowedTools: allowedToolsForSave,
        });
        router.push('/settings/skills');
      }
    } catch {
      setError(t('settings.skillLibrary.errors.save'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleClone = async () => {
    if (!existing) return;
    setIsSaving(true);
    try {
      const copy = await clone(existing.id);
      if (copy) router.push(`/settings/skills/${copy.id}`);
    } catch {
      setError(t('settings.skillLibrary.errors.clone'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportJson = () => {
    if (!existing) return;
    const json = {
      slug: existing.slug,
      name,
      description,
      body,
      config,
    };
    triggerDownload(JSON.stringify(json, null, 2), `${existing.slug}.json`, 'application/json');
  };

  const handleExportMarkdown = () => {
    if (!existing) return;
    triggerDownload(
      skillToMarkdown({ name, description, body, config }),
      `${existing.slug}.md`,
      'text/markdown'
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="truncate text-xl font-bold">
          {mode === 'new'
            ? t('settings.skillLibrary.form.newTitle')
            : existing
              ? skillDisplayName(existing, t)
              : t('settings.skillLibrary.form.skillFallback')}
        </h1>
        {mode === 'edit' && existing ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('settings.skillLibrary.actions.moreOptions')}
              >
                <MoreVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={handleClone}>
                {t('settings.skillLibrary.actions.clone')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleExportJson}>
                {t('settings.skillLibrary.actions.exportJson')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleExportMarkdown}>
                {t('settings.skillLibrary.actions.exportMarkdown')}
              </DropdownMenuItem>
              {!existing.system ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setPendingDelete(true)}
                  >
                    {t('settings.skillLibrary.actions.delete')}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {isReadOnly ? (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          {t('settings.skillLibrary.form.readOnly')}
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="name">{t('settings.skillLibrary.form.nameLabel')}</Label>
        <Input
          id="name"
          value={isReadOnly && existing ? skillDisplayName(existing, t) : name}
          onChange={e => setName(e.target.value)}
          disabled={isReadOnly}
          maxLength={80}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description" className="text-muted-foreground">
          {t('settings.skillLibrary.form.descriptionLabel')}
        </Label>
        <Input
          id="description"
          value={isReadOnly && existing ? skillDisplayDescription(existing, t) : description}
          onChange={e => setDescription(e.target.value)}
          disabled={isReadOnly}
          placeholder={t('settings.skillLibrary.form.descriptionPlaceholder')}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="body" className="text-base font-medium">
          {t('settings.skillLibrary.form.promptLabel')}
        </Label>
        <Textarea
          id="body"
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={12}
          className="min-h-[280px] font-mono"
          placeholder={t('settings.skillLibrary.form.promptPlaceholder')}
          disabled={isReadOnly}
        />
      </div>

      {!isReadOnly && toolsEnabled && effectiveOutputTarget !== 'note-title' && (
        <div className="space-y-2">
          <Label>{t('settings.skillLibrary.form.toolsLabel')}</Label>
          <SkillToolsPicker value={allowedTools} onChange={setAllowedTools} />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Switch
          id="transcript-input"
          checked={includeTranscript}
          disabled={isReadOnly}
          onCheckedChange={setIncludeTranscript}
        />
        <div>
          <Label htmlFor="transcript-input">{t('notes.includeTranscript')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.skillLibrary.form.transcriptDescription')}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t('settings.skillLibrary.form.modeLabel')}</Label>
        <RadioGroup
          value={config.editingOptions}
          onValueChange={v => setEditingOptions(v as ArtifactMode)}
          disabled={isReadOnly || effectiveOutputTarget === 'note-title' || restrictedMode}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="append-section" id="m-as" aria-describedby="m-as-description" />
            <div className="space-y-1">
              <Label htmlFor="m-as" className="font-normal">
                {t('settings.skillLibrary.form.addSection')}
              </Label>
              <p id="m-as-description" className="text-xs text-muted-foreground">
                {t('settings.skillLibrary.form.addSectionDescription')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="replace-doc" id="m-rd" aria-describedby="m-rd-description" />
            <div className="space-y-1">
              <Label htmlFor="m-rd" className="font-normal">
                {t('settings.skillLibrary.form.rewriteNote')}
              </Label>
              <p id="m-rd-description" className="text-xs text-muted-foreground">
                {t('settings.skillLibrary.form.rewriteNoteDescription')}
              </p>
            </div>
          </div>
          {advancedEnabled && (
            <div className="flex items-center gap-2">
              <RadioGroupItem value="inline-rewrite" id="m-ir" />
              <Label htmlFor="m-ir" className="font-normal">
                {t('settings.skillLibrary.modes.inlineRewrite')}
              </Label>
            </div>
          )}
        </RadioGroup>
        {restrictedMode && (
          <p className="text-xs text-muted-foreground">
            {t('settings.skillLibrary.form.preservedMode')}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="enabled">{t('settings.skillLibrary.form.enabled')}</Label>
        <Switch id="enabled" checked={enabled} onCheckedChange={setEnabled} disabled={isReadOnly} />
      </div>
      {advancedEnabled && (
        <details className="rounded-lg border bg-card open:p-4 [&:not([open])]:p-3 [&:not([open])>summary]:m-0">
          <summary className="cursor-pointer select-none text-sm font-medium text-muted-foreground">
            {t('settings.skillLibrary.form.advanced')}
          </summary>
          <div className="mt-4 space-y-5">
            <div className="flex items-center gap-2">
              <Switch
                id="title-output"
                checked={outputTarget === 'note-title'}
                disabled={isReadOnly}
                onCheckedChange={value => setOutputTarget(value ? 'note-title' : 'note-body')}
              />
              <div>
                <Label htmlFor="title-output">{t('notes.titleOutput')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.skillLibrary.form.titleDescription')}
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('settings.skillLibrary.form.surfacesLabel')}</Label>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="s-dock"
                    checked={outputTarget === 'note-title' || surfaces.has('dock')}
                    onCheckedChange={c => setSurfaces(prev => toggleSet(prev, 'dock', c === true))}
                    disabled={isReadOnly || outputTarget === 'note-title'}
                  />
                  <Label htmlFor="s-dock" className="font-normal">
                    {t('settings.skillLibrary.surfaces.dock')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="s-inline"
                    checked={outputTarget !== 'note-title' && surfaces.has('inline')}
                    onCheckedChange={c =>
                      setSurfaces(prev => toggleSet(prev, 'inline', c === true))
                    }
                    disabled={isReadOnly || outputTarget === 'note-title'}
                  />
                  <Label htmlFor="s-inline" className="font-normal">
                    {t('settings.skillLibrary.surfaces.inline')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="s-ask"
                    checked={outputTarget !== 'note-title' && surfaces.has('ask')}
                    onCheckedChange={c => setSurfaces(prev => toggleSet(prev, 'ask', c === true))}
                    disabled={isReadOnly || outputTarget === 'note-title'}
                  />
                  <Label htmlFor="s-ask" className="font-normal">
                    {t('settings.skillLibrary.surfaces.ask')}
                  </Label>
                </div>
              </div>
            </div>

            {/* Ask-AI scope — only relevant when the skill is offered on the Ask AI surface. */}
            {outputTarget !== 'note-title' && surfaces.has('ask') && (
              <div className="space-y-2">
                <Label>{t('settings.skillLibrary.askScope.label')}</Label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {ASK_SCOPE_OPTIONS.map(scope => (
                    <button
                      key={scope}
                      type="button"
                      disabled={isReadOnly}
                      aria-pressed={askScope === scope}
                      onClick={() => setAskScope(scope)}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors',
                        askScope === scope
                          ? 'border-primary bg-primary/5 ring-1 ring-primary'
                          : 'border-border hover:bg-accent',
                        isReadOnly && 'cursor-not-allowed opacity-60'
                      )}
                    >
                      <div className="text-sm font-medium">
                        {t(
                          scope === 'single-note'
                            ? 'settings.skillLibrary.askScope.singleTitle'
                            : 'settings.skillLibrary.askScope.multiTitle'
                        )}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t(
                          scope === 'single-note'
                            ? 'settings.skillLibrary.askScope.singleDescription'
                            : 'settings.skillLibrary.askScope.multiDescription'
                        )}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between">
              <Label htmlFor="default">{t('settings.skillLibrary.form.defaultLabel')}</Label>
              <Switch
                id="default"
                checked={outputTarget !== 'note-title' && defaultSkill}
                onCheckedChange={setDefaultSkill}
                disabled={isReadOnly || outputTarget === 'note-title'}
              />
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                id="mode-agnostic"
                checked={modeAgnosticPrompt}
                onCheckedChange={c => setModeAgnosticPrompt(c === true)}
                disabled={isReadOnly || outputTarget === 'note-title'}
                className="mt-0.5"
              />
              <div className="space-y-1">
                <Label htmlFor="mode-agnostic" className="font-normal">
                  {t('settings.skillLibrary.form.modeAgnosticLabel')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.skillLibrary.form.modeAgnosticDescription')}
                </p>
              </div>
            </div>
          </div>
        </details>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isReadOnly || isSaving}>
          {mode === 'new'
            ? t('settings.skillLibrary.actions.create')
            : t('settings.skillLibrary.actions.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.push('/settings/skills')}>
          {t('settings.skillLibrary.actions.cancel')}
        </Button>
      </div>

      <DeleteSkillDialog
        skill={pendingDelete && existing ? existing : null}
        pending={deleting}
        onCancel={() => setPendingDelete(false)}
        onConfirm={async () => {
          setDeleting(true);
          try {
            if (existing) await remove(existing.id);
            router.push('/settings/skills');
          } catch {
            setDeleting(false);
            setPendingDelete(false);
            setError(t('settings.skillLibrary.errors.delete'));
          }
        }}
      />
    </form>
  );
}
