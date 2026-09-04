'use client';

import { useState, type ReactNode } from 'react';
import { AudioLines, FileText } from 'lucide-react';
import { useFeatureFlag } from '@prismical/app-client';

import { type ProviderType } from '../../../lib/providers';

import { AIModelsProvider } from './components/ai-models-store';
import DefaultCard from './components/default-card';
import ChangeDefaultDialog from './components/change-default-dialog';
import ConnectedList from './components/connected-list';
import AvailableTiles from './components/available-tiles';
import InstanceFormDialog, { type InstanceFormMode } from './components/instance-form-dialog';
import { useTranslation } from 'react-i18next';

type ChangeTarget = 'transcription' | 'formatting' | null;

/**
 * `providerSettings`: the platform's AI-provider card — the
 * desktop router passes its desktop-owned card (BYO key / local runtime); web
 * passes nothing. A named slot, not a capability branch in this screen.
 */
function AIModelsSettingsContent({ providerSettings }: { providerSettings?: ReactNode }) {
  const { t } = useTranslation();
  // The page owns each dialog's open state so children can trigger them via
  // callback (avoids prop-drilling open/close all the way down).
  const [changeTarget, setChangeTarget] = useState<ChangeTarget>(null);
  const [formMode, setFormMode] = useState<InstanceFormMode | null>(null);
  // The BYOK instance CRUD (defaults, connected list, add-a-provider) is an org
  // feature — off in the desktop local workspace, whose providers live
  // in the `providerSettings` slot above instead.
  const { enabled: byokInstances } = useFeatureFlag('byokInstances');

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">{t('settings.aiModels.title')}</h1>

      {providerSettings ? <section className="mb-6">{providerSettings}</section> : null}

      {byokInstances && (
        <>
          <section className="mb-6">
            <h2 className="text-sm font-semibold text-muted-foreground mb-2">
              {t('settings.aiModels.defaults')}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
              <DefaultCard
                useCase="transcription"
                title={t('settings.aiModels.useCases.transcription.title')}
                description={t('settings.aiModels.useCases.transcription.description')}
                Icon={AudioLines}
                onChange={() => setChangeTarget('transcription')}
              />
              <DefaultCard
                useCase="formatting"
                title={t('settings.aiModels.useCases.formatting.title')}
                description={t('settings.aiModels.useCases.formatting.description')}
                Icon={FileText}
                onChange={() => setChangeTarget('formatting')}
              />
            </div>
          </section>

          <section className="mb-6">
            <h2 className="text-sm font-semibold text-muted-foreground mb-2">
              {t('settings.aiModels.connected')}
            </h2>
            <ConnectedList onEdit={id => setFormMode({ kind: 'edit', id })} />
          </section>

          <section>
            <h2 className="text-sm font-semibold text-muted-foreground mb-2">
              {t('settings.aiModels.addProvider')}
            </h2>
            <AvailableTiles
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
            />
          )}

          <InstanceFormDialog
            open={!!formMode}
            onOpenChange={open => {
              if (!open) setFormMode(null);
            }}
            mode={formMode}
          />
        </>
      )}

    </div>
  );
}

export function AiModelsScreen({ providerSettings }: { providerSettings?: ReactNode } = {}) {
  return (
    <AIModelsProvider>
      <AIModelsSettingsContent providerSettings={providerSettings} />
    </AIModelsProvider>
  );
}
