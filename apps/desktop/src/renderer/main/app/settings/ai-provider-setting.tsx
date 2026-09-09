/**
 * The AI provider card is desktop-owned: the desktop
 * router hands it to the shared AI-models screen through its `providerSettings`
 * slot; the card gates on the 'ai-provider' capability and never branches on
 * the app mode.
 *
 * The provider choice + the non-secret fields (model, base URL) ride
 * DeviceSettings.ai (ONE record — a patch replaces it, so every write spreads
 * the current value). API keys ride DesktopCapabilityPort.aiProvider into
 * main's secure store, one slot per provider: the input is never pre-filled,
 * and only a "key saved" boolean ever comes back. The live model catalogue is
 * best-effort — an unreachable provider shows a reason, never blocks a save.
 */
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AiModelListing,
  AiProviderKind,
  AiProviderSetting as AiProviderRecord,
} from '@prismical/app-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useDesktopCapabilities, useDeviceSettings } from '@prismical/app-client';
import { Button } from '@prismical/app-ui/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@prismical/app-ui/ui/card';
import { Input } from '@prismical/app-ui/ui/input';
import { Label } from '@prismical/app-ui/ui/label';
import { RadioGroup, RadioGroupItem } from '@prismical/app-ui/ui/radio-group';
import { CommittedInput } from './committed-input';

const PROVIDERS: readonly AiProviderKind[] = [
  'openai',
  'anthropic',
  'openrouter',
  'openai-compatible',
  'ollama',
];
const isProvider = (value: string): value is AiProviderKind =>
  (PROVIDERS as readonly string[]).includes(value);

/** Which fields a provider needs: a key (Ollama never), a base URL (the hosted APIs never). */
const HAS_KEY: Record<AiProviderKind, boolean> = {
  openai: true,
  anthropic: true,
  openrouter: true,
  'openai-compatible': true,
  ollama: false,
};
const HAS_BASE_URL: Record<AiProviderKind, boolean> = {
  openai: false,
  anthropic: false,
  openrouter: false,
  'openai-compatible': true,
  ollama: true,
};
const BASE_URL_PLACEHOLDER: Record<AiProviderKind, string> = {
  openai: '',
  anthropic: '',
  openrouter: '',
  'openai-compatible': 'http://localhost:1234/v1',
  ollama: 'http://127.0.0.1:11434',
};
const MODEL_LIST_ID = 'ai-provider-model-list';

function KeyField({ provider, onChanged }: { provider: AiProviderKind; onChanged: () => void }) {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  const [key, setKey] = React.useState('');
  const [hasKey, setHasKey] = React.useState<boolean | null>(null);
  // Re-read the "key saved" boolean after every set/clear (the key itself
  // never comes back).
  const [keyVersion, setKeyVersion] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setHasKey(null);
    void caps.aiProvider.hasKey(provider).then(value => {
      if (active) setHasKey(value);
    });
    return () => {
      active = false;
    };
  }, [caps, provider, keyVersion]);

  const saveKey = async (): Promise<void> => {
    const trimmed = key.trim();
    if (trimmed.length === 0) return;
    await caps.aiProvider.setKey(provider, trimmed);
    setKey('');
    setKeyVersion(version => version + 1);
    onChanged();
  };
  const clearKey = async (): Promise<void> => {
    await caps.aiProvider.clearKey(provider);
    setKeyVersion(version => version + 1);
    onChanged();
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor="ai-provider-api-key">{t('desktop.aiProvider.apiKeyLabel')}</Label>
      <div className="flex items-center gap-2">
        <Input
          id="ai-provider-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder={t('desktop.aiProvider.apiKeyPlaceholder')}
          onChange={event => setKey(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') void saveKey();
          }}
        />
        <Button size="sm" disabled={key.trim().length === 0} onClick={() => void saveKey()}>
          {t('desktop.aiProvider.saveKey')}
        </Button>
      </div>
      {hasKey === null ? null : (
        <div
          className="flex items-center justify-between gap-2"
          data-testid="ai-provider-key-status"
          data-has-key={hasKey}
        >
          <p className="text-xs text-muted-foreground">
            {hasKey ? t('desktop.aiProvider.keySet') : t('desktop.aiProvider.keyMissing')}
          </p>
          {hasKey ? (
            <Button variant="ghost" size="sm" onClick={() => void clearKey()}>
              {t('desktop.aiProvider.clearKey')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function CatalogueStatus({
  listing,
  onRefresh,
}: {
  listing: AiModelListing | null;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const state = listing === null ? 'loading' : listing.error === null ? 'ready' : listing.error;
  const text =
    listing === null
      ? t('desktop.aiProvider.catalogue.loading')
      : listing.error === null
        ? t('desktop.aiProvider.catalogue.count', { count: listing.models.length })
        : t(`desktop.aiProvider.catalogue.${camel(listing.error)}`);
  return (
    <div
      className="flex items-center justify-between gap-2"
      data-testid="ai-provider-catalogue"
      data-state={state}
    >
      <p className="text-xs text-muted-foreground">{text}</p>
      <Button variant="ghost" size="sm" onClick={onRefresh}>
        {t('desktop.aiProvider.refreshModels')}
      </Button>
    </div>
  );
}

/** 'not-configured' → 'notConfigured' (the i18n key shape). */
const camel = (value: string): string => value.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export function AiProviderSetting() {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  const { settings, set } = useDeviceSettings();
  const qc = useQueryClient();
  const ai = settings.ai;
  const [listing, setListing] = React.useState<AiModelListing | null>(null);
  // A bumped version is an explicit re-fetch (Refresh, a key change): it
  // bypasses main's brief cache; a provider/base-URL change just re-reads.
  const [listingVersion, setListingVersion] = React.useState(0);
  const forceRef = React.useRef(false);
  const enabled = caps.has('ai-provider');

  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    setListing(null);
    const force = forceRef.current;
    forceRef.current = false;
    void caps.aiProvider.listModels(ai.provider, force).then(value => {
      if (active) setListing(value);
    });
    return () => {
      active = false;
    };
    // The base URL is part of what is listed; a commit re-lists.
  }, [caps, enabled, ai.provider, ai.baseUrl, listingVersion]);

  if (!enabled) return null;

  // The skill runner reads its (instanceId, modelId) from the model-defaults
  // query and the Ask picker its groups from the instances query — both are
  // derived from this record in local mode, so a change must refetch them or
  // runs keep going to the previous provider.
  const invalidateDerived = (): void => {
    void qc.invalidateQueries({ queryKey: ['model-defaults'] });
    void qc.invalidateQueries({ queryKey: ['instances'] });
  };
  const patch = (fields: Partial<AiProviderRecord>): void => {
    void set({ ai: { ...ai, ...fields } }).then(invalidateDerived);
  };
  const refresh = (): void => {
    forceRef.current = true;
    setListingVersion(version => version + 1);
    invalidateDerived();
  };

  return (
    <Card data-testid="ai-provider">
      <CardHeader>
        <CardTitle>{t('desktop.aiProvider.title')}</CardTitle>
        <CardDescription>{t('desktop.aiProvider.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <RadioGroup
          value={ai.provider}
          onValueChange={value => {
            if (isProvider(value)) {
              patch({ provider: value, model: null, baseUrl: null });
            }
          }}
          aria-label={t('desktop.aiProvider.title')}
        >
          {PROVIDERS.map(provider => (
            <div key={provider} className="flex items-start gap-3">
              <RadioGroupItem value={provider} id={`ai-provider-${provider}`} className="mt-0.5" />
              <div className="space-y-1">
                <Label
                  htmlFor={`ai-provider-${provider}`}
                  className="text-sm font-medium text-foreground"
                >
                  {t(`desktop.aiProvider.providers.${provider}.label`)}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(`desktop.aiProvider.providers.${provider}.description`)}
                </p>
              </div>
            </div>
          ))}
        </RadioGroup>

        <div
          className="space-y-4 rounded-md border border-border p-4"
          data-testid="ai-provider-fields"
        >
          {HAS_BASE_URL[ai.provider] ? (
            <div className="space-y-1.5">
              <Label htmlFor="ai-provider-base-url">{t('desktop.aiProvider.baseUrlLabel')}</Label>
              <CommittedInput
                id="ai-provider-base-url"
                value={ai.baseUrl ?? ''}
                placeholder={BASE_URL_PLACEHOLDER[ai.provider]}
                onCommit={next => patch({ baseUrl: next.trim() || null })}
              />
            </div>
          ) : null}
          {HAS_KEY[ai.provider] ? (
            // Keyed by provider: a typed-but-unsaved key must not outlive the
            // provider it was typed for (it would be saved into the next slot).
            <KeyField key={ai.provider} provider={ai.provider} onChanged={refresh} />
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="ai-provider-model">{t('desktop.aiProvider.modelLabel')}</Label>
            <CommittedInput
              id="ai-provider-model"
              value={ai.model ?? ''}
              placeholder={t('desktop.aiProvider.modelPlaceholder')}
              list={MODEL_LIST_ID}
              onCommit={next => patch({ model: next.trim() || null })}
            />
            <datalist id={MODEL_LIST_ID}>
              {(listing?.models ?? []).map(id => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <CatalogueStatus listing={listing} onRefresh={refresh} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
