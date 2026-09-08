import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function OnboardingFrame({
  step,
  children,
  footer,
  error,
  testId = 'mode-chooser',
}: {
  step: 'discovery' | 'permissions' | 'mode' | 'calendar';
  children: ReactNode;
  footer: ReactNode;
  error?: string | null;
  testId?: string;
}) {
  const { t } = useTranslation();
  const steps =
    step === 'calendar'
      ? (['discovery', 'permissions', 'mode', 'calendar'] as const)
      : (['discovery', 'permissions', 'mode'] as const);
  return (
    <div
      data-testid={testId}
      data-step={step}
      className="auth-gate bg-background text-foreground fixed inset-0 z-20 flex overflow-y-auto px-6 py-12"
    >
      <div className="auth-gate-drag" />
      <main className="auth-gate-card m-auto w-full max-w-2xl">
        <div className="mb-10 flex items-center gap-3">
          <img src="/prismical-icon.svg" alt="" className="size-8" />
          <span data-testid="mode-chooser-brand" className="text-lg font-medium">
            Prismical
          </span>
        </div>
        <ol aria-label={t('desktop.onboarding.progress')} className="mb-10 flex gap-2">
          {steps.map((item, index) => (
            <li
              key={item}
              aria-current={item === step ? 'step' : undefined}
              className={`flex-1 border-t-2 pt-3 text-xs ${index <= steps.findIndex(item => item === step) ? 'border-primary text-foreground' : 'border-border text-muted-foreground'}`}
            >
              {t(`desktop.onboarding.steps.${item}`)}
            </li>
          ))}
        </ol>
        <h1 className="text-3xl font-semibold tracking-tight">
          {t(`desktop.onboarding.${step}.title`)}
        </h1>
        <p className="text-muted-foreground mt-3 mb-8 text-sm leading-relaxed">
          {t(
            step === 'mode'
              ? 'desktop.modeChooser.cloud.description'
              : `desktop.onboarding.${step}.description`
          )}
        </p>
        {children}
        {error && (
          <p role="alert" className="text-destructive mt-4 text-sm">
            {error}
          </p>
        )}
        <div className="mt-8 flex items-center justify-between gap-3 border-t pt-5">{footer}</div>
      </main>
    </div>
  );
}
