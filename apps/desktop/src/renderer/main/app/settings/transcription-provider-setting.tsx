/** Local workspace transcription calls this provider directly from the device. */
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { TranscriptionSetting } from '@prismical/app-contracts';
import { useDesktopCapabilities } from '@prismical/app-client';
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

export function TranscriptionProviderSetting({ transcription, onPatch }: {
  transcription: TranscriptionSetting;
  onPatch: (fields: Partial<TranscriptionSetting>) => void;
}) {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  const storedBaseUrl = transcription.byokBaseUrl ?? '';
  const storedModel = transcription.byokModel ?? '';
  const [draft, setDraft] = React.useState({ baseUrl: storedBaseUrl, model: storedModel });
  const [seen, setSeen] = React.useState({ baseUrl: storedBaseUrl, model: storedModel });
  if (seen.baseUrl !== storedBaseUrl || seen.model !== storedModel) {
    setSeen({ baseUrl: storedBaseUrl, model: storedModel });
    // A delayed acknowledgement must not replace a newer visible edit.
    setDraft(current => ({
      baseUrl: current.baseUrl === seen.baseUrl ? storedBaseUrl : current.baseUrl,
      model: current.model === seen.model ? storedModel : current.model,
    }));
  }
  const { baseUrl, model } = draft;
  // Commit both visible fields together, including when activating the provider.
  const patch = (fields: Partial<TranscriptionSetting> = {}): void => {
    onPatch({
      byokBaseUrl: baseUrl.trim() || null,
      byokModel: model.trim() || null,
      ...fields,
    });
  };
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
    <Card data-testid="transcription-provider">
      <CardHeader>
        <CardTitle>{t('desktop.transcriptionProvider.title')}</CardTitle>
        <CardDescription>{t('desktop.transcriptionProvider.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-4 rounded-md border border-border p-4" data-testid="byok-fields">
          <div className="space-y-1.5">
            <Label htmlFor="byok-base-url">
              {t('desktop.transcriptionEngine.byok.baseUrlLabel')}
            </Label>
            <Input
              id="byok-base-url"
              value={baseUrl}
              placeholder={t('desktop.transcriptionEngine.byok.baseUrlPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={event => setDraft({ ...draft, baseUrl: event.target.value })}
              onBlur={() => {
                if (baseUrl !== storedBaseUrl) patch();
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="byok-model">{t('desktop.transcriptionEngine.byok.modelLabel')}</Label>
            <Input
              id="byok-model"
              value={model}
              placeholder={t('desktop.transcriptionEngine.byok.modelPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={event => setDraft({ ...draft, model: event.target.value })}
              onBlur={() => {
                if (model !== storedModel) patch();
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="byok-api-key">
              {t('desktop.transcriptionEngine.byok.apiKeyLabel')}
            </Label>
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
        {transcription.engine === 'byok' ? (
          <p className="text-sm font-medium" data-testid="transcription-provider-active">
            {t('desktop.transcriptionProvider.active')}
          </p>
        ) : (
          <Button variant="outline" size="sm" onClick={() => patch({ engine: 'byok' })}>
            {t('desktop.transcriptionProvider.useModel')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
