'use client';

import { useId, type ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../../../shell/app-link';
import { Button } from '../../../../ui/button';

/** Keep the real settings visible while preventing pointer and keyboard interaction. */
export default function ByokPlanGate({
  blocked,
  pending = false,
  children,
}: {
  blocked: boolean;
  pending?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const disabled = blocked || pending;
  const titleId = useId();
  const descriptionId = useId();

  return (
    <div className="relative isolate grid">
      <div inert={disabled} className="col-start-1 row-start-1">
        <fieldset disabled={disabled} className="min-w-0 border-0 p-0 m-0">
          {children}
        </fieldset>
      </div>
      {blocked && (
        <div className="relative z-10 col-start-1 row-start-1 flex items-start justify-center rounded-xl bg-black/20 p-4 sm:p-8">
          <section
            role="dialog"
            aria-modal={false}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            className="grid w-full max-w-md gap-4 rounded-lg border bg-background p-6 text-foreground shadow-lg"
          >
            <div className="flex size-11 items-center justify-center rounded-xl border bg-muted">
              <KeyRound aria-hidden="true" className="size-5" />
            </div>
            <div className="flex flex-col gap-2 text-left">
              <p className="text-xs font-medium text-muted-foreground">
                {t('settings.aiModels.planGate.availability')}
              </p>
              <h2 id={titleId} className="text-lg font-semibold leading-none">{t('settings.aiModels.planGate.title')}</h2>
              <p id={descriptionId} className="text-sm text-muted-foreground leading-relaxed">
                {t('settings.aiModels.planGate.description')}
              </p>
            </div>
            <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button asChild variant="outline">
                <AppLink href="/settings/preferences">{t('settings.aiModels.planGate.back')}</AppLink>
              </Button>
              <Button asChild>
                <AppLink href="/settings/billing">{t('settings.aiModels.planGate.upgrade')}</AppLink>
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
