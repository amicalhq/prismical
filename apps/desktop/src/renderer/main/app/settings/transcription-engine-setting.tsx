/**
 * The transcription engine card is desktop-owned: the
 * desktop router hands it to the shared TranscriptionScreen through its
 * `engineSettings` slot; the card itself gates on the 'transcription-engine'
 * capability and never branches on the app mode.
 *
 * The engine choice + the non-secret BYOK fields (base URL, model) ride
 * DeviceSettings.transcription (ONE record — a patch replaces it, so every
 * write spreads the current value). The BYOK API key rides
 * DesktopCapabilityPort.transcriptionByok into main's secure store: the input
 * is never pre-filled, and only a "key saved" boolean ever comes back.
 */
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { TranscriptionEngine, TranscriptionSetting } from '@prismical/app-contracts';
import { useDesktopCapabilities, useDeviceSettings } from '@prismical/app-client';
import { useDesktopEnv } from '../desktop-env';
import { AppLink } from '@prismical/app-ui/shell/app-link';
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

const ENGINES: readonly TranscriptionEngine[] = ['cloud', 'local', 'byok'];
const isEngine = (value: string): value is TranscriptionEngine =>
  (ENGINES as readonly string[]).includes(value);

function ByokFields({
  transcription,
  onPatch,
}: {
  transcription: TranscriptionSetting;
  onPatch: (fields: Partial<TranscriptionSetting>) => void;
}) {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  const storedBaseUrl = transcription.byokBaseUrl ?? '';
  const [baseUrl, setBaseUrl] = React.useState(storedBaseUrl);
  const [seenBaseUrl, setSeenBaseUrl] = React.useState(storedBaseUrl);
  if (seenBaseUrl !== storedBaseUrl) {
    setSeenBaseUrl(storedBaseUrl);
    // A delayed settings acknowledgement must not replace a newer visible edit.
    if (baseUrl === seenBaseUrl) setBaseUrl(storedBaseUrl);
  }
  const [key, setKey] = React.useState('');
  const [hasKey, setHasKey] = React.useState<boolean | null>(null);
  // Re-read the "key saved" boolean after every set/clear (the key itself
  // never comes back).
  const [keyVersion, setKeyVersion] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setHasKey(null);
    if (baseUrl.trim() !== storedBaseUrl.trim()) {
      setHasKey(false);
      return;
    }
    void caps.transcriptionByok.hasKey().then(value => {
      if (active) setHasKey(value);
    });
    return () => {
      active = false;
    };
  }, [caps, keyVersion, baseUrl, storedBaseUrl]);

  const saveKey = async (): Promise<void> => {
    const trimmed = key.trim();
    const endpoint = baseUrl.trim();
    if (trimmed.length === 0 || !endpoint) return;
    await caps.transcriptionByok.setKey(trimmed, endpoint);
    setKey('');
    setKeyVersion(version => version + 1);
  };
  const clearKey = async (): Promise<void> => {
    await caps.transcriptionByok.clearKey();
    setKeyVersion(version => version + 1);
  };

  return (
    <div className="space-y-4 rounded-md border border-border p-4" data-testid="byok-fields">
      <div className="space-y-1.5">
        <Label htmlFor="byok-base-url">{t('desktop.transcriptionEngine.byok.baseUrlLabel')}</Label>
        <Input
          id="byok-base-url"
          value={baseUrl}
          placeholder={t('desktop.transcriptionEngine.byok.baseUrlPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={event => setBaseUrl(event.target.value)}
          onBlur={() => {
            if (baseUrl !== storedBaseUrl) onPatch({ byokBaseUrl: baseUrl.trim() || null });
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="byok-model">{t('desktop.transcriptionEngine.byok.modelLabel')}</Label>
        <CommittedInput
          id="byok-model"
          value={transcription.byokModel ?? ''}
          placeholder={t('desktop.transcriptionEngine.byok.modelPlaceholder')}
          onCommit={next => onPatch({ byokModel: next.trim() || null })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="byok-api-key">{t('desktop.transcriptionEngine.byok.apiKeyLabel')}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="byok-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            placeholder={t('desktop.transcriptionEngine.byok.apiKeyPlaceholder')}
            onChange={event => setKey(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void saveKey();
            }}
          />
          <Button
            size="sm"
            disabled={key.trim().length === 0 || !baseUrl.trim()}
            onClick={() => void saveKey()}
          >
            {t('desktop.transcriptionEngine.byok.saveKey')}
          </Button>
        </div>
        {hasKey === null ? null : (
          <div
            className="flex items-center justify-between gap-2"
            data-testid="byok-key-status"
            data-has-key={hasKey}
          >
            <p className="text-xs text-muted-foreground">
              {hasKey
                ? t('desktop.transcriptionEngine.byok.keySet')
                : t('desktop.transcriptionEngine.byok.keyMissing')}
            </p>
            {hasKey ? (
              <Button variant="ghost" size="sm" onClick={() => void clearKey()}>
                {t('desktop.transcriptionEngine.byok.clearKey')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export function TranscriptionEngineSetting() {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  const { settings, set } = useDeviceSettings();
  // This is desktop-owned, so the mode may be read here: local mode has no
  // Prismical Cloud engine to offer — main coerces a stored 'cloud' to
  // 'local' per recording, so the card shows that effective choice.
  const localMode = useDesktopEnv().appMode === 'local';
  if (!caps.has('transcription-engine')) return null;

  const transcription = settings.transcription;
  const offered = localMode ? ENGINES.filter(engine => engine !== 'cloud') : ENGINES;
  const selected = localMode && transcription.engine === 'cloud' ? 'local' : transcription.engine;
  const patch = (fields: Partial<TranscriptionSetting>): void => {
    void set({ transcription: { ...transcription, ...fields } });
  };

  return (
    <Card data-testid="transcription-engine">
      <CardHeader>
        <CardTitle>{t('desktop.transcriptionEngine.title')}</CardTitle>
        <CardDescription>{t('desktop.transcriptionEngine.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <RadioGroup
          value={selected}
          onValueChange={value => {
            if (isEngine(value)) patch({ engine: value });
          }}
          aria-label={t('desktop.transcriptionEngine.title')}
        >
          {offered.map(engine => (
            <div key={engine} className="flex items-start gap-3">
              <RadioGroupItem
                value={engine}
                id={`transcription-engine-${engine}`}
                className="mt-0.5"
              />
              <div className="space-y-1">
                <Label
                  htmlFor={`transcription-engine-${engine}`}
                  className="text-sm font-medium text-foreground"
                >
                  {t(`desktop.transcriptionEngine.engines.${engine}.label`)}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(`desktop.transcriptionEngine.engines.${engine}.description`)}
                </p>
              </div>
            </div>
          ))}
        </RadioGroup>

        {selected === 'local' ? (
          <Button asChild variant="outline" size="sm">
            <AppLink href="/settings/local-models">
              {t('desktop.transcriptionEngine.manageModels')}
            </AppLink>
          </Button>
        ) : null}

        {transcription.engine === 'byok' ? (
          <ByokFields transcription={transcription} onPatch={patch} />
        ) : null}
      </CardContent>
    </Card>
  );
}
