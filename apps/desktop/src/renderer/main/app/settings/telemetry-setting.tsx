import { useId, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from '@prismical/app-ui/ui/label';
import { Switch } from '@prismical/app-ui/ui/switch';
import { getTelemetryState, refreshTelemetryState, subscribeTelemetryState } from '../../../telemetry';

/** Uses main's effective policy; a local synthetic session is still signed out. */
export function TelemetrySetting() {
  const { t } = useTranslation();
  const id = useId();
  const state = useSyncExternalStore(subscribeTelemetryState, getTelemetryState);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (state === null || state.signedIn || !state.canChangePreference) return null;

  const change = async (preference: boolean): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      await window.desktop.settings.set({ telemetryOptOut: !preference });
      const next = await refreshTelemetryState(window.desktop.telemetry);
      setFailed(next.preference !== preference);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="telemetry-setting" className="space-y-2 rounded-lg border p-4 text-left">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor={id}>{t('desktop.telemetry.title')}</Label>
          <p className="text-muted-foreground text-xs">{t('desktop.telemetry.description')}</p>
        </div>
        <Switch id={id} checked={state.preference} disabled={busy}
          onCheckedChange={value => { void change(value); }} />
      </div>
      {failed ? <p role="alert" className="text-destructive text-xs">{t('common.errors.generic')}</p> : null}
    </div>
  );
}
