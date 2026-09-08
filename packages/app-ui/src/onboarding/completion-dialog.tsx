'use client';
import { Users, GraduationCap, Mic, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
export function OnboardingCompletionDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <span className="mx-auto mb-2 flex size-12 items-center justify-center rounded-2xl bg-primary/10">
            <Check aria-hidden="true" className="size-6" />
          </span>
          <DialogTitle className="text-center">{t('onboarding.doneTitle')}</DialogTitle>
          <DialogDescription className="text-center">{t('onboarding.doneBody')}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-3">
          {(['meetings', 'lectures', 'voiceNotes'] as const).map(useCase => {
            const Icon = { meetings: Users, lectures: GraduationCap, voiceNotes: Mic }[useCase];
            return (
              <li key={useCase} className="flex items-start gap-3 rounded-xl border p-3">
                <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-indigo-500 dark:text-indigo-400" />
                <p className="text-sm leading-relaxed">
                  <span className="font-medium">{t(`onboarding.useCases.${useCase}.title`)}</span>
                  {' - '}
                  <span className="text-muted-foreground">{t(`onboarding.useCases.${useCase}.body`)}</span>
                </p>
              </li>
            );
          })}
        </ul>
        <a href="https://prismical.ai/docs" target="_blank" rel="noreferrer" className="text-center text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t('onboarding.helpDocs')}
        </a>
        <DialogFooter>
          <Button className="w-full" onClick={onClose}>
            {t('onboarding.continueToNote')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
