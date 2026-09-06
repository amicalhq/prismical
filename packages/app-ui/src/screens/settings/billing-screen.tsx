'use client';

import * as React from 'react';
import { ArrowUpRight, Check, CreditCard, Info, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  type BillingInterval,
  type PlanCatalogEntry,
  useCreateBillingPortal,
  useCreatePlanCheckout,
  usePlanAccess,
} from '@prismical/app-client';
import { cn } from '../../lib/utils';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Skeleton } from '../../ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip';
import { localizeBillingPlan, localizeSubscriptionState } from './billing-plan-presentation';

// Plans already at the seat-based / enterprise tier have nothing to upgrade to,
// so their available-plan cards are hidden. Keep these browser-safe literals in
// sync with PLAN_EXTERNAL_IDS.BUSINESS / .ENTERPRISE.
const PLANS_WITHOUT_UPSELL = new Set<string>(['plan_business', 'plan_enterprise']);

function DetailTooltip({ label, content }: { label: string; content?: string }) {
  const { t } = useTranslation();
  if (!content) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex text-muted-foreground/60 transition-colors hover:text-foreground"
          aria-label={t('settings.billing.accessibility.moreInformation', { label })}
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{content}</TooltipContent>
    </Tooltip>
  );
}

function PlanCard({
  plan,
  current,
  interval,
  pending,
  onSelect,
}: {
  plan: PlanCatalogEntry;
  current: boolean;
  interval: BillingInterval;
  pending: boolean;
  onSelect: (plan: PlanCatalogEntry) => void;
}) {
  const { t } = useTranslation();
  const checkoutOption =
    plan.checkoutOptions?.find(option => option.interval === interval) ?? plan.checkoutOptions?.[0];
  const canAct = plan.checkoutEligible || Boolean(plan.contactHref);
  const buttonLabel = current ? t('settings.billing.screen.currentPlan') : plan.ctaLabel;

  return (
    <Card
      className={cn(
        'relative flex h-full flex-col overflow-hidden bg-card/60',
        current && 'border-primary ring-1 ring-primary/20',
        !current && plan.badge && 'border-primary/40 shadow-sm'
      )}
    >
      {plan.badge ? <Badge className="absolute right-4 top-4">{plan.badge}</Badge> : null}
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2">
          <CardTitle className="text-lg">{plan.displayName}</CardTitle>
          {current ? <Badge variant="outline">{t('settings.billing.screen.current')}</Badge> : null}
        </div>
        <p className={cn('min-h-10 text-sm text-muted-foreground', plan.badge && 'pr-24')}>
          {plan.description}
        </p>
        <div className="pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-3xl font-semibold tracking-tight">
              {checkoutOption?.price ?? plan.price}
            </p>
            {plan.perUser ? (
              <span className="text-xs text-muted-foreground">
                {t('settings.billing.plans.common.perUser')}
              </span>
            ) : null}
            {checkoutOption?.badge ? (
              <Badge variant="secondary">{checkoutOption.badge}</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {checkoutOption?.billingLabel ?? plan.billingLabel}
          </p>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col pt-0">
        <div className="space-y-2.5 border-y py-4">
          {plan.limits.map(limit => (
            <div
              key={`${limit.value}-${limit.label}`}
              className="flex items-center gap-1.5 text-sm"
            >
              <span className="font-semibold">{limit.value}</span>
              <span className="text-muted-foreground">{limit.label}</span>
              <DetailTooltip label={limit.label} content={limit.tooltip} />
            </div>
          ))}
        </div>

        <div className="py-5">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {plan.inherits ?? t('settings.billing.plans.common.whatsIncluded')}
          </p>
          <ul className="space-y-2.5 text-sm">
            {plan.features.map(feature => (
              <li key={feature.text} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                <span className="flex flex-wrap items-center gap-1">
                  {feature.text}
                  {feature.note ? (
                    <span className="text-xs text-muted-foreground">({feature.note})</span>
                  ) : null}
                  <DetailTooltip label={feature.text} content={feature.tooltip} />
                </span>
              </li>
            ))}
          </ul>
        </div>

        <Button
          className="mt-auto w-full"
          variant={current ? 'outline' : plan.contactSales ? 'secondary' : 'default'}
          disabled={current || !canAct || pending}
          onClick={() => onSelect(plan)}
        >
          {pending ? (
            <Loader2 className="animate-spin" />
          ) : plan.contactSales && !current ? (
            <ArrowUpRight />
          ) : null}
          {buttonLabel}
        </Button>
      </CardContent>
    </Card>
  );
}

export function BillingScreen() {
  const { t } = useTranslation();
  const planQuery = usePlanAccess();
  const checkout = useCreatePlanCheckout();
  const portal = useCreateBillingPortal();
  const [billingInterval, setBillingInterval] = React.useState<BillingInterval>('year');
  const [actionError, setActionError] = React.useState<string | null>(null);

  const startCheckout = (plan: PlanCatalogEntry) => {
    setActionError(null);

    if (!plan.checkoutEligible && plan.contactHref) {
      window.location.assign(plan.contactHref);
      return;
    }

    checkout.mutate(
      {
        planExternalId: plan.checkoutPlanExternalId ?? plan.externalId,
        billingInterval,
      },
      {
        onSuccess: result => window.location.assign(result.checkoutUrl),
        onError: () => setActionError(t('settings.billing.errors.checkout')),
      }
    );
  };

  const openPortal = () => {
    setActionError(null);
    portal.mutate(undefined, {
      onSuccess: result => window.location.assign(result.portalUrl),
      onError: () => setActionError(t('settings.billing.errors.portal')),
    });
  };

  if (planQuery.isPending) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold">{t('settings.billing.screen.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('settings.billing.screen.loadingDescription')}
          </p>
        </div>
        <Skeleton className="h-36 w-full" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-[34rem] w-full" />
          <Skeleton className="h-[34rem] w-full" />
          <Skeleton className="h-[34rem] w-full" />
        </div>
      </div>
    );
  }

  if (planQuery.isError || !planQuery.data) {
    return (
      <div>
        <h1 className="text-xl font-bold">{t('settings.billing.screen.title')}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {t('settings.billing.screen.adminOnly')}
        </p>
      </div>
    );
  }

  const { plan, plans, subscription, usage, entitlements } = planQuery.data;
  const localizedPlans = plans.map(item => localizeBillingPlan(item, t));
  // The metered dimensions of the plan, when this core reports them. Under an hour the usage reads
  // in whole minutes (a 2-minute recording must visibly move the meter; 0.0 h would not), from an
  // hour up in hours to one decimal. Limits are always hours. A null limit is "unlimited".
  const hours = (seconds: number) => (Math.round(seconds / 360) / 10).toString();
  const minutes = (seconds: number) => Math.round(seconds / 60).toString();
  const meters: Array<{ key: string; label: string; value: string }> = [];
  if (usage.cloudTranscriptionSeconds) {
    const m = usage.cloudTranscriptionSeconds;
    const subHour = m.used < 3600;
    meters.push({
      key: 'transcription',
      label: t('settings.billing.screen.usageCloudTranscription'),
      value:
        m.limit === null
          ? subHour
            ? t('settings.billing.screen.usageMinutesUnlimited', { used: minutes(m.used) })
            : t('settings.billing.screen.usageHoursUnlimited', { used: hours(m.used) })
          : subHour
            ? t('settings.billing.screen.usageMinutes', { used: minutes(m.used), limit: hours(m.limit) })
            : t('settings.billing.screen.usageHours', { used: hours(m.used), limit: hours(m.limit) }),
    });
  }
  if (usage.aiCredits) {
    const m = usage.aiCredits;
    meters.push({
      key: 'credits',
      label: t('settings.billing.screen.usageAiCredits'),
      value:
        m.limit === null
          ? t('settings.billing.screen.usageCountUnlimited', { used: m.used })
          : t('settings.billing.screen.usageCount', { used: m.used, limit: m.limit }),
    });
  }
  meters.push({
    key: 'seats',
    label: t('settings.billing.screen.usageSeats'),
    value:
      usage.seatsLimit === null
        ? t('settings.billing.screen.usageCountUnlimited', { used: usage.seatsUsed })
        : t('settings.billing.screen.usageCount', { used: usage.seatsUsed, limit: usage.seatsLimit }),
  });
  const meterResetsAt = usage.meterResetsAt ? new Date(usage.meterResetsAt) : null;
  const sortedPlans = [...localizedPlans].sort((a, b) => a.sortOrder - b.sortOrder);
  const currentCatalogPlan = localizedPlans.find(item => item.externalId === plan.externalId);
  const hasBillingOptions = sortedPlans.some(item => (item.checkoutOptions?.length ?? 0) > 1);

  return (
    <TooltipProvider>
      <div className="space-y-7">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-xl font-bold">{t('settings.billing.screen.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('settings.billing.screen.description')}
            </p>
          </div>
          <a
            href="https://prismical.ai/pricing"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            {t('settings.billing.actions.fullComparison')}
            <ArrowUpRight className="size-4" />
          </a>
        </div>

        <Card className="bg-card/60">
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <CreditCard className="size-4" />
                {t('settings.billing.screen.currentPlan')}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <CardTitle className="text-2xl">
                  {currentCatalogPlan?.displayName ?? plan.displayName}
                </CardTitle>
                <Badge variant="secondary" className="capitalize">
                  {localizeSubscriptionState(subscription.state, t)}
                </Badge>
              </div>
              {currentCatalogPlan ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  {currentCatalogPlan.description}
                </p>
              ) : null}
            </div>
            {subscription.biller === 'dodo' ? (
              <Button variant="outline" disabled={portal.isPending} onClick={openPortal}>
                {portal.isPending ? <Loader2 className="animate-spin" /> : null}
                {t('settings.billing.actions.manage')}
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="border-t pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('settings.billing.screen.usageTitle')}
            </p>
            <dl className="mt-2 grid gap-3 sm:grid-cols-3">
              {meters.map(meter => (
                <div key={meter.key}>
                  <dt className="text-sm text-muted-foreground">{meter.label}</dt>
                  <dd className="text-base font-semibold tabular-nums">{meter.value}</dd>
                </div>
              ))}
            </dl>
            {entitlements?.pooled || meterResetsAt ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {[
                  entitlements?.pooled ? t('settings.billing.screen.usagePooled') : null,
                  meterResetsAt
                    ? t('settings.billing.screen.usageResets', {
                        date: meterResetsAt.toLocaleDateString(),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {PLANS_WITHOUT_UPSELL.has(plan.externalId) ? null : (
          <section className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="font-semibold">{t('settings.billing.screen.chooseTitle')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('settings.billing.screen.chooseDescription')}
                </p>
              </div>
              {hasBillingOptions ? (
                <div className="flex items-center gap-2">
                  <div className="grid grid-cols-2 rounded-full bg-muted p-1">
                    {(['month', 'year'] as const).map(interval => (
                      <button
                        key={interval}
                        type="button"
                        className={cn(
                          'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                          billingInterval === interval
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                        onClick={() => setBillingInterval(interval)}
                      >
                        {interval === 'month'
                          ? t('settings.billing.actions.monthly')
                          : t('settings.billing.actions.annual')}
                      </button>
                    ))}
                  </div>
                  <Badge variant="secondary">{t('settings.billing.actions.save')}</Badge>
                </div>
              ) : null}
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              {sortedPlans.map(item => (
                <PlanCard
                  key={item.externalId}
                  plan={item}
                  current={item.externalId === plan.externalId}
                  interval={billingInterval}
                  pending={
                    checkout.isPending &&
                    checkout.variables?.planExternalId ===
                      (item.checkoutPlanExternalId ?? item.externalId)
                  }
                  onSelect={startCheckout}
                />
              ))}
            </div>
          </section>
        )}

        {actionError ? (
          <p className="text-sm text-destructive" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
