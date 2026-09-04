'use client';

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { ChevronDown, Loader2, Sparkles } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../ui/dialog';
import { Button } from '../../../../ui/button';
import { Checkbox } from '../../../../ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../../../ui/collapsible';
import { Input } from '../../../../ui/input';
import { Label } from '../../../../ui/label';
import type { InstanceConfig, UseCase } from '../../mock-data';
import {
  CLOUD_CATALOG_PROVIDERS,
  PROVIDER_META,
  PROVIDER_TYPE_CONFIG_FIELDS,
  PROVIDER_TYPE_CAPABILITIES,
  type InstanceConfigFieldName,
  type InstanceConfigFieldSpec,
  type ModelType,
  type ProviderType,
} from '../../../../lib/providers';
import { useCreateInstance, useUpdateInstance } from '@prismical/app-client';
import { useModelDefaults, useSetModelDefault } from '@prismical/app-client';

import { useAIModels } from './ai-models-store';
import { ModelCuration } from './model-curation';
import { SingleModelPicker } from './single-model-picker';
import { useTranslation } from 'react-i18next';

export type InstanceFormMode =
  | { kind: 'create'; provider: ProviderType }
  | { kind: 'edit'; id: string };

interface InstanceFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: InstanceFormMode | null;
}

const FIELD_LABEL_KEYS = {
  apiKey: 'settings.aiModels.form.fields.apiKey',
  url: 'settings.aiModels.form.fields.url',
  baseURL: 'settings.aiModels.form.fields.baseUrl',
  supportsStrictJsonSchema: 'settings.aiModels.form.fields.strictJson',
} as const satisfies Record<InstanceConfigFieldName, string>;
const FIELD_PLACEHOLDERS: Partial<Record<InstanceConfigFieldName, string>> = {
  apiKey: 'sk-...',
  url: 'http://localhost:11434',
  baseURL: 'https://api.example.com/v1',
};
const SECRET_FIELDS = new Set<string>(['apiKey']);

// ─── wizard steps ───────────────────────────────────────────────────────────
type WizardStep = 'connect' | 'ask' | 'skills' | 'transcribe';
const STEP_TITLE_KEYS = {
  connect: 'settings.aiModels.form.steps.connect',
  ask: 'settings.aiModels.form.steps.ask',
  skills: 'settings.aiModels.form.steps.skills',
  transcribe: 'settings.aiModels.form.steps.transcribe',
} as const satisfies Record<WizardStep, string>;

/** Steps the create wizard shows for a provider — connect, plus capability steps for catalog providers. */
function stepsForProvider(provider: ProviderType): WizardStep[] {
  const steps: WizardStep[] = ['connect'];
  if (!CLOUD_CATALOG_PROVIDERS.includes(provider)) return steps;
  const caps = PROVIDER_TYPE_CAPABILITIES[provider];
  if (caps.includes('language')) steps.push('ask', 'skills');
  if (caps.includes('transcription')) steps.push('transcribe');
  return steps;
}

export default function InstanceFormDialog({ open, onOpenChange, mode }: InstanceFormDialogProps) {
  const provider: ProviderType | null = useMemo(() => {
    if (mode?.kind === 'create') return mode.provider;
    return null;
  }, [mode]);

  if (mode?.kind === 'edit') {
    return <EditInstanceDialog open={open} onOpenChange={onOpenChange} id={mode.id} />;
  }
  if (!provider) return null;
  return (
    <CreateInstanceWizard
      key={open ? provider : 'closed'}
      open={open}
      onOpenChange={onOpenChange}
      provider={provider}
    />
  );
}

// ─── create wizard ────────────────────────────────────────────────────────────
function CreateInstanceWizard({
  open,
  onOpenChange,
  provider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderType;
}) {
  const { t } = useTranslation();
  const createM = useCreateInstance();
  const updateM = useUpdateInstance();
  const setDefaultM = useSetModelDefault();

  const fields = PROVIDER_TYPE_CONFIG_FIELDS[provider];
  const meta = PROVIDER_META[provider];
  const steps = useMemo(() => stepsForProvider(provider), [provider]);

  const [stepIdx, setStepIdx] = useState(0);
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [skillsModel, setSkillsModel] = useState<string | null>(null);
  const [transcribeModel, setTranscribeModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'connect' | 'save' | null>(null);

  const step: WizardStep = steps[stepIdx] ?? 'connect';
  const isLast = stepIdx === steps.length - 1;

  const requiredFilled = fields
    .filter(f => f.required)
    .every(
      f => typeof values[f.field] === 'string' && (values[f.field] as string).trim().length > 0
    );
  const canConnect = label.trim().length > 0 && requiredFilled && !busy;

  const buildConfig = (): Record<string, unknown> => {
    const cfg: Record<string, unknown> = {};
    for (const f of fields) {
      if (SECRET_FIELDS.has(f.field)) continue;
      const v = values[f.field];
      if (f.inputType === 'checkbox') {
        if (typeof v === 'boolean') cfg[f.field] = v;
      } else if (typeof v === 'string' && v.trim()) {
        cfg[f.field] = v.trim();
      }
    }
    return cfg;
  };
  const buildCredentials = (): Record<string, unknown> | undefined => {
    const creds: Record<string, string> = {};
    for (const f of fields) {
      if (!SECRET_FIELDS.has(f.field)) continue;
      const v = values[f.field];
      if (typeof v === 'string' && v.trim()) creds[f.field] = v.trim();
    }
    return Object.keys(creds).length > 0 ? creds : undefined;
  };

  // Step 1 → create the instance (the catalog fetch on the next step validates the key).
  const handleConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const cfg = buildConfig();
      const created = await createM.mutateAsync({
        provider,
        label: label.trim(),
        config: cfg as InstanceConfig,
        credentials: buildCredentials(),
      });
      setCreatedId(created.id);
      setConfig(cfg);
      if (steps.length === 1) {
        onOpenChange(false); // connect-only provider (no catalog steps)
        return;
      }
      setStepIdx(1);
    } catch {
      setError('connect');
    } finally {
      setBusy(false);
    }
  };

  const persistCuration = async () => {
    if (!createdId) return;
    const cfg = selectedModels.length > 0 ? { ...config, selectedModels } : { ...config };
    if (selectedModels.length === 0) delete (cfg as { selectedModels?: unknown }).selectedModels;
    await updateM.mutateAsync({
      id: createdId,
      patch: { label: label.trim(), config: cfg as InstanceConfig },
    });
    setConfig(cfg);
  };

  const advance = async () => {
    setBusy(true);
    setError(null);
    try {
      if (step === 'ask') await persistCuration();
      if (step === 'skills' && createdId && skillsModel) {
        await setDefaultM.mutateAsync({
          useCase: 'formatting',
          instanceId: createdId,
          modelId: skillsModel,
        });
      }
      if (step === 'transcribe' && createdId && transcribeModel) {
        await setDefaultM.mutateAsync({
          useCase: 'transcription',
          instanceId: createdId,
          modelId: transcribeModel,
        });
      }
      if (isLast) {
        onOpenChange(false);
        return;
      }
      setStepIdx(i => i + 1);
    } catch {
      setError('save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <meta.Logo className={`size-5 ${meta.tint ?? ''}`} />
            {t('settings.aiModels.form.addTitle', { provider: meta.label })}
          </DialogTitle>
          <DialogDescription>
            {t('settings.aiModels.form.step', {
              current: stepIdx + 1,
              total: steps.length,
              step: t(STEP_TITLE_KEYS[step]),
            })}
          </DialogDescription>
        </DialogHeader>

        {/* Stepper */}
        {steps.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {steps.map((s, i) => (
              <span key={s} className="flex items-center gap-1.5">
                <span
                  className={`inline-flex size-5 items-center justify-center rounded-full text-2xs font-bold ${
                    i < stepIdx
                      ? 'bg-success text-white'
                      : i === stepIdx
                        ? 'bg-primary text-primary-foreground'
                        : 'border text-muted-foreground'
                  }`}
                >
                  {i < stepIdx ? '✓' : i + 1}
                </span>
                <span className={i === stepIdx ? 'font-medium' : 'text-muted-foreground'}>
                  {t(STEP_TITLE_KEYS[s])}
                </span>
                {i < steps.length - 1 && <span className="text-muted-foreground/40">→</span>}
              </span>
            ))}
          </div>
        )}

        <div className="space-y-4 py-2">
          {step === 'connect' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="instance-label">{t('settings.aiModels.form.fields.label')}</Label>
                <Input
                  id="instance-label"
                  placeholder={t('settings.aiModels.form.personalLabel', {
                    provider: meta.label,
                  })}
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  autoFocus
                />
              </div>
              {fields
                .filter(f => !f.advanced)
                .map(f => (
                  <ConfigField key={f.field} field={f} values={values} setValues={setValues} />
                ))}
              {fields.some(f => f.advanced) && (
                <Collapsible className="space-y-2">
                  <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-dashed border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent">
                    {t('settings.aiModels.form.advanced')}
                    <ChevronDown className="h-3 w-3 transition-transform data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-4 pt-2">
                    {fields
                      .filter(f => f.advanced)
                      .map(f => (
                        <ConfigField
                          key={f.field}
                          field={f}
                          values={values}
                          setValues={setValues}
                        />
                      ))}
                  </CollapsibleContent>
                </Collapsible>
              )}
            </>
          )}

          {step === 'ask' && createdId && (
            <div>
              <p className="mb-2 text-xs text-muted-foreground">
                {t('settings.aiModels.form.askDefaultDescription')}
              </p>
              <ModelCuration
                instanceId={createdId}
                value={selectedModels}
                onChange={setSelectedModels}
                enabled={open}
              />
            </div>
          )}

          {step === 'skills' && createdId && (
            <DefaultStep
              label={t('settings.aiModels.form.defaultSkills')}
              instanceId={createdId}
              modelType="language"
              useCaseLabel={t('settings.aiModels.useCases.formatting.pickerLabel')}
              value={skillsModel}
              onChange={setSkillsModel}
              open={open}
            />
          )}

          {step === 'transcribe' && createdId && (
            <DefaultStep
              label={t('settings.aiModels.form.defaultTranscription')}
              instanceId={createdId}
              modelType="transcription"
              useCaseLabel={t('settings.aiModels.useCases.transcription.pickerLabel')}
              value={transcribeModel}
              onChange={setTranscribeModel}
              open={open}
            />
          )}

          {error && (
            <p className="text-xs text-destructive">
              {t(
                error === 'connect'
                  ? 'settings.aiModels.form.connectError'
                  : 'settings.aiModels.form.saveError'
              )}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.actions.cancel')}
          </Button>
          {step === 'connect' ? (
            <Button onClick={handleConnect} disabled={!canConnect}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {steps.length === 1
                ? t('settings.aiModels.form.add')
                : t('settings.aiModels.form.steps.connect')}
            </Button>
          ) : (
            <Button onClick={advance} disabled={busy}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {isLast ? t('settings.aiModels.form.finish') : t('settings.aiModels.form.next')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A wizard default step: an Auto option + the capability-filtered single picker. */
function DefaultStep({
  label,
  instanceId,
  modelType,
  useCaseLabel,
  value,
  onChange,
  open,
}: {
  label: string;
  instanceId: string;
  modelType: ModelType;
  useCaseLabel: string;
  value: string | null;
  onChange: (v: string | null) => void;
  open: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <button
        type="button"
        onClick={() => onChange(null)}
        className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${
          value === null ? 'border-primary bg-accent' : 'hover:bg-accent'
        }`}
      >
        <Sparkles className="size-4 text-muted-foreground" />
        {t('settings.aiModels.managedAuto')}
      </button>
      <SingleModelPicker
        instanceId={instanceId}
        modelType={modelType}
        value={value}
        onChange={onChange}
        enabled={open}
        useCaseLabel={useCaseLabel}
      />
    </div>
  );
}

// ─── edit dialog (connection + collapsed default rows) ─────────────────────────
function EditInstanceDialog({
  open,
  onOpenChange,
  id,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  id: string;
}) {
  const { t } = useTranslation();
  const { getInstance } = useAIModels();
  const updateM = useUpdateInstance();
  const setDefaultM = useSetModelDefault();
  const { data: defaults } = useModelDefaults();
  const existing = getInstance(id);
  const provider = existing?.provider ?? null;
  const fields = provider ? PROVIDER_TYPE_CONFIG_FIELDS[provider] : [];
  const showCuration = provider !== null && CLOUD_CATALOG_PROVIDERS.includes(provider);
  const caps = provider ? PROVIDER_TYPE_CAPABILITIES[provider] : [];

  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open || !existing) return;
    setLabel(existing.label);
    const cfg = existing.config as Record<string, unknown>;
    const next: Record<string, string | boolean> = {};
    for (const f of fields) {
      const v = cfg[f.field];
      next[f.field] =
        f.inputType === 'checkbox'
          ? typeof v === 'boolean'
            ? v
            : false
          : typeof v === 'string'
            ? v
            : '';
    }
    setValues(next);
    const sm = cfg.selectedModels;
    setSelectedModels(
      Array.isArray(sm) ? sm.filter((x): x is string => typeof x === 'string') : []
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only on open/instance change
  }, [open, id]);

  if (!existing || !provider) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common.status.loading')}</DialogTitle>
            <DialogDescription className="sr-only">
              {t('settings.aiModels.form.loadingDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }
  const meta = PROVIDER_META[provider];

  const buildConfig = (): InstanceConfig => {
    const cfg: Record<string, unknown> = { ...(existing.config as Record<string, unknown>) };
    for (const f of fields) {
      if (SECRET_FIELDS.has(f.field)) continue;
      const v = values[f.field];
      if (f.inputType === 'checkbox') {
        if (typeof v === 'boolean') cfg[f.field] = v;
      } else if (typeof v === 'string' && v.trim()) cfg[f.field] = v.trim();
    }
    if (showCuration) {
      if (selectedModels.length > 0) cfg.selectedModels = selectedModels;
      else delete cfg.selectedModels;
    }
    return cfg as InstanceConfig;
  };
  const buildCredentials = (): Record<string, unknown> | undefined => {
    const creds: Record<string, string> = {};
    for (const f of fields) {
      if (!SECRET_FIELDS.has(f.field)) continue;
      const v = values[f.field];
      if (typeof v === 'string' && v.trim()) creds[f.field] = v.trim();
    }
    return Object.keys(creds).length > 0 ? creds : undefined;
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateM.mutateAsync({
        id,
        patch: { label: label.trim(), config: buildConfig(), credentials: buildCredentials() },
      });
      onOpenChange(false);
    } catch {
      // The shared mutation error handler shows a toast; keep the dialog open so the user can retry.
    } finally {
      setIsSaving(false);
    }
  };

  // Show the current default's model id when it points at THIS instance (else "Prismical Cloud · Auto").
  const defaultLabel = (uc: UseCase) => {
    const d = uc === 'formatting' ? defaults?.formatting : defaults?.transcription;
    return d && d.instanceId === id && d.modelId
      ? d.modelId
      : t('settings.aiModels.managedAutoShort');
  };
  const setDefaultFor = (uc: UseCase, modelId: string) =>
    setDefaultM.mutate({ useCase: uc, instanceId: id, modelId });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <meta.Logo className={`size-5 ${meta.tint ?? ''}`} />
            {t('settings.aiModels.form.editTitle', {
              provider: meta.label,
              name: existing.label,
            })}
          </DialogTitle>
          <DialogDescription>{t('settings.aiModels.form.editDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="edit-label">{t('settings.aiModels.form.fields.label')}</Label>
            <Input id="edit-label" value={label} onChange={e => setLabel(e.target.value)} />
          </div>
          {fields
            .filter(f => !f.advanced)
            .map(f => (
              <ConfigField key={f.field} field={f} values={values} setValues={setValues} isEdit />
            ))}

          {showCuration && (
            <div className="space-y-1 border-t pt-3">
              {/* Ask — Manage curated list */}
              <Collapsible className="space-y-2">
                <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-1 py-2 text-sm hover:bg-accent">
                  <span className="font-medium">
                    {t('settings.aiModels.form.askPickerTitle')}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t('settings.aiModels.form.selected', { count: selectedModels.length })}
                    </span>
                  </span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform data-[state=open]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ModelCuration
                    instanceId={id}
                    value={selectedModels}
                    onChange={setSelectedModels}
                    enabled={open}
                  />
                </CollapsibleContent>
              </Collapsible>

              {/* Skills (formatting) default */}
              {caps.includes('language') && (
                <EditDefaultRow
                  title={t('settings.aiModels.form.textGenerationDefault')}
                  current={defaultLabel('formatting')}
                  instanceId={id}
                  modelType="language"
                  useCaseLabel={t('settings.aiModels.useCases.formatting.pickerLabel')}
                  open={open}
                  onPick={m => setDefaultFor('formatting', m)}
                />
              )}

              {/* Transcription default */}
              {caps.includes('transcription') && (
                <EditDefaultRow
                  title={t('settings.aiModels.form.transcriptionDefault')}
                  current={defaultLabel('transcription')}
                  instanceId={id}
                  modelType="transcription"
                  useCaseLabel={t('settings.aiModels.useCases.transcription.pickerLabel')}
                  open={open}
                  onPick={m => setDefaultFor('transcription', m)}
                />
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('common.actions.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t('common.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One collapsed default row in the edit dialog: shows the current model, expands a single picker. */
function EditDefaultRow({
  title,
  current,
  instanceId,
  modelType,
  useCaseLabel,
  open,
  onPick,
}: {
  title: string;
  current: string;
  instanceId: string;
  modelType: ModelType;
  useCaseLabel: string;
  open: boolean;
  onPick: (modelId: string) => void;
}) {
  return (
    <Collapsible className="space-y-2">
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-1 py-2 text-sm hover:bg-accent">
        <span className="min-w-0 text-left">
          <span className="font-medium">{title}</span>
          <span className="ml-2 truncate text-xs text-muted-foreground">{current}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SingleModelPicker
          instanceId={instanceId}
          modelType={modelType}
          value={null}
          onChange={onPick}
          enabled={open}
          useCaseLabel={useCaseLabel}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function ConfigField({
  field: f,
  values,
  setValues,
  isEdit = false,
}: {
  field: InstanceConfigFieldSpec;
  values: Record<string, string | boolean>;
  setValues: Dispatch<SetStateAction<Record<string, string | boolean>>>;
  isEdit?: boolean;
}) {
  const { t } = useTranslation();
  if (f.inputType === 'checkbox') {
    const checked = values[f.field] === true;
    return (
      <div key={f.field} className="space-y-2">
        <div className="flex items-start gap-2">
          <Checkbox
            id={`instance-${f.field}`}
            checked={checked}
            onCheckedChange={v => setValues(prev => ({ ...prev, [f.field]: v === true }))}
          />
          <Label htmlFor={`instance-${f.field}`} className="text-sm font-normal leading-snug">
            {t(FIELD_LABEL_KEYS[f.field])}
          </Label>
        </div>
        {f.field === 'supportsStrictJsonSchema' && (
          <p className="text-xs text-muted-foreground pl-6">
            {t('settings.aiModels.form.fields.strictJsonHelp')}
          </p>
        )}
      </div>
    );
  }
  const stringValue = typeof values[f.field] === 'string' ? (values[f.field] as string) : '';
  return (
    <div key={f.field} className="space-y-2">
      <Label htmlFor={`instance-${f.field}`}>
        {t(FIELD_LABEL_KEYS[f.field])}
        {f.required && !isEdit && <span className="text-destructive"> *</span>}
      </Label>
      <Input
        id={`instance-${f.field}`}
        type={f.inputType}
        placeholder={
          isEdit && SECRET_FIELDS.has(f.field)
            ? t('settings.aiModels.form.leaveKeyBlank')
            : FIELD_PLACEHOLDERS[f.field]
        }
        value={stringValue}
        onChange={e => setValues(prev => ({ ...prev, [f.field]: e.target.value }))}
      />
    </div>
  );
}
