'use client';
import { usePorts } from '@prismical/app-client';
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
export function OnboardingWelcomeDialog({
  open,
  onStart,
  onClose,
}: {
  open: boolean;
  onStart: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { assets } = usePorts();
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="prismical-welcome gap-7 rounded-2xl p-8 sm:max-w-md">
        <DialogHeader className="items-center text-center sm:text-center">
          <div className="mb-4 flex size-20 items-center justify-center rounded-3xl bg-indigo-500/5 ring-1 ring-indigo-400/15">
            <img src={assets.resolve('/prismical-icon.svg')} alt="Prismical" width={56} height={56} className="size-14" />
          </div>
          <DialogTitle className="text-2xl leading-tight tracking-tight">{t('onboarding.welcomeHeading')}</DialogTitle>
          <p className="mt-5 text-base font-medium text-foreground">{t('onboarding.welcomeTitle')}</p>
          <DialogDescription className="mt-1 text-sm leading-relaxed">{t('onboarding.welcomeBody')}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-center">
          <Button variant="ghost" onClick={onClose}>
            {t('onboarding.later')}
          </Button>
          <Button className="bg-indigo-600 text-white hover:bg-indigo-500" onClick={onStart}>{t('onboarding.start')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
