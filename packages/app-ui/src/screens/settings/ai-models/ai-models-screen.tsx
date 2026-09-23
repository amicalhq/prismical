'use client';

import { useState, type ReactNode } from 'react';
import { AudioLines, FileText } from 'lucide-react';
import { useEntitlements, useFeatureFlag } from '@prismical/app-client';
import { ByokUpgradeBanner, ByokUpgradeDialog, type ByokAccess } from './components/byok-upgrade';

import { type ProviderType } from '../../../lib/providers';

import { AIModelsProvider } from './components/ai-models-store';
import DefaultCard from './components/default-card';
import { DeviceTranscriptionChoices, DeviceTranscriptionSummary, type DeviceTranscription } from './components/device-transcription';
import ChangeDefaultDialog from './components/change-default-dialog';
import ConnectedList from './components/connected-list';
import AvailableTiles from './components/available-tiles';
import InstanceFormDialog, { type InstanceFormMode } from './components/instance-form-dialog';
import { useTranslation } from 'react-i18next';

type ChangeTarget = 'transcription' | 'formatting' | null;

/**
 * `providerSettings`: the platform's local AI controls — the
 * desktop router passes its direct provider configuration; web
 * passes nothing. A named slot, not a capability branch in this screen.
 */
function AIModelsSettingsContent({
  providerSettings,
  deviceTranscription,
  onAccountTranscriptionSelected,
}: {
  providerSettings?: ReactNode;
  deviceTranscription?: DeviceTranscription;
  onAccountTranscriptionSelected?: () => void;
}) {
  const { t } = useTranslation();
  // The page owns each dialog's open state so children can trigger them via
  // callback (avoids prop-drilling open/close all the way down).
  const [changeTarget, setChangeTarget] = useState<ChangeTarget>(null);
  const [formMode, setFormMode] = useState<InstanceFormMode | null>(null);
  // The BYOK instance CRUD (defaults, connected list, add-a-provider) is an org
  // feature — off in the desktop local workspace, whose providers live
  // in the `providerSettings` slot above instead.
  const { enabled: byokInstances } = useFeatureFlag('byokInstances');
  // BYOK is gated per control, not per page: Auto, the defaults, and removing an instance stay open
  // on every plan; only connecting and choosing your own provider need it. The server still
  // enforces BYOK_NOT_IN_PLAN - this is the same decision rendered.
  const { entitlements, isResolved } = useEntitlements();
  const byokAccess: ByokAccess = !isResolved
    ? 'pending'
    : entitlements.features.byok
      ? 'allowed'
      : 'locked';
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const showUpgrade = () => setUpgradeOpen(true);

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">{t('settings.aiModels.title')}</h1>

      {providerSettings ? <section className="mb-6">{providerSettings}</section> : null}

      {!byokInstances && deviceTranscription && (
        <section className="mb-6 space-y-3">
          <h2 className="text-sm font-semibold">{t('settings.aiModels.deviceTranscription.title')}</h2>
          {deviceTranscription.active && <DeviceTranscriptionSummary device={deviceTranscription} />}
          <DeviceTranscriptionChoices device={deviceTranscription} />
        </section>
      )}

      {byokInstances && (
        <>
          <section className="mb-6">
            <h2 className="text-sm font-semibold text-muted-foreground mb-2">
              {t('settings.aiModels.defaults')}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
              <DefaultCard
                useCase="transcription"
                deviceTranscription={deviceTranscription}
                title={t('settings.aiModels.useCases.transcription.title')}
                description={t('settings.aiModels.useCases.transcription.description')}
                Icon={AudioLines}
                byokAccess={byokAccess}
                onChange={() => setChangeTarget('transcription')}
              />
              <DefaultCard
                useCase="formatting"
                title={t('settings.aiModels.useCases.formatting.title')}
                description={t('settings.aiModels.useCases.formatting.description')}
                Icon={FileText}
                byokAccess={byokAccess}
                onChange={() => setChangeTarget('formatting')}
              />
            </div>
          </section>

          <section className="mb-6">
            <h2 className="text-sm font-semibold text-muted-foreground mb-2">
              {t('settings.aiModels.connected')}
            </h2>
            <ConnectedList
              byokAccess={byokAccess}
              onEdit={id => setFormMode({ kind: 'edit', id })}
            />
          </section>

          <section>
            <h2 className="text-sm font-semibold text-muted-foreground mb-2">
              {t('settings.aiModels.addProvider')}
            </h2>
            {byokAccess === 'locked' && <ByokUpgradeBanner />}
            <AvailableTiles
              byokAccess={byokAccess}
              onLocked={showUpgrade}
              onAddCloud={(provider: ProviderType) => setFormMode({ kind: 'create', provider })}
            />
          </section>

          {changeTarget && (
            <ChangeDefaultDialog
              open={!!changeTarget}
              onOpenChange={open => {
                if (!open) setChangeTarget(null);
              }}
              useCase={changeTarget}
              deviceTranscription={changeTarget === 'transcription' ? deviceTranscription : undefined}
              byokAccess={byokAccess}
              onLocked={() => {
                setChangeTarget(null);
                showUpgrade();
              }}
              onTranscriptionSelected={onAccountTranscriptionSelected}
            />
          )}

          {byokAccess === 'allowed' && (
            <InstanceFormDialog
              open={!!formMode}
              onOpenChange={open => {
                if (!open) setFormMode(current => current === formMode ? null : current);
              }}
              mode={formMode}
              onTranscriptionSelected={onAccountTranscriptionSelected}
            />
          )}

          <ByokUpgradeDialog open={upgradeOpen} onOpenChange={setUpgradeOpen} />
        </>
      )}

    </div>
  );
}

export function AiModelsScreen({
  providerSettings,
  deviceTranscription,
  onAccountTranscriptionSelected,
}: {
  providerSettings?: ReactNode;
  deviceTranscription?: DeviceTranscription;
  onAccountTranscriptionSelected?: () => void;
} = {}) {
  return (
    <AIModelsProvider>
      <AIModelsSettingsContent
        providerSettings={providerSettings}
        deviceTranscription={deviceTranscription}
        onAccountTranscriptionSelected={onAccountTranscriptionSelected}
      />
    </AIModelsProvider>
  );
}
