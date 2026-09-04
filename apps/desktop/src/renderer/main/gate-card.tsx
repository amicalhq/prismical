/**
 * The pre-shell card chrome shared by the sign-in gate (auth-gate.tsx) and the
 * first-run mode chooser (app/mode-chooser.tsx): logo,
 * "Welcome to Prismical", "AI note taker", the bordered/shadowed card — the
 * same card the hosted login page draws, so every pre-product surface reads as
 * one product.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@prismical/app-ui/ui/card';

/**
 * The logo + wordmark block, mirroring the hosted login page's card header.
 * The wordmark is its own node so it reads exactly "Prismical" — the smoke spec
 * pins that text, while the sentence around it varies by surface.
 */
export function GateHeader({ brandTestId = 'auth-brand' }: { brandTestId?: string }) {
  const { t } = useTranslation();
  const productName = 'Prismical';
  const welcome = String(t('desktop.auth.welcome', { productName }));
  const [welcomeBefore, welcomeAfter = ''] = welcome.split(productName);
  return (
    <div className="mb-7 flex flex-col items-center gap-4">
      <img src="/prismical-icon.svg" alt="" className="h-10 w-auto" />
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          {welcomeBefore}
          <span data-testid={brandTestId}>{productName}</span>
          {welcomeAfter}
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">{t('desktop.auth.subtitle')}</p>
      </div>
    </div>
  );
}

/**
 * The card. `wide` widens it from the gate's max-w-sm to max-w-md — the mode
 * chooser lays out two options and needs the room. `brandTestId` lets a card
 * that paints OVER the gate (the chooser) keep the wordmark testid unique.
 */
export function GateCard({
  children,
  testId,
  wide = false,
  brandTestId,
}: {
  children: ReactNode;
  testId?: string;
  wide?: boolean;
  brandTestId?: string;
}) {
  return (
    <Card
      className={`w-full ${wide ? 'max-w-md' : 'max-w-sm'} border px-8 py-7 shadow-lg`}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      <GateHeader {...(brandTestId === undefined ? {} : { brandTestId })} />
      {children}
    </Card>
  );
}
