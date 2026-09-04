import type { PlanCatalogEntry } from '@prismical/app-client';
import type { ApplicationTFunction } from '@prismical/app-i18n';

function localizeFreePlan(plan: PlanCatalogEntry, t: ApplicationTFunction): PlanCatalogEntry {
  return {
    ...plan,
    displayName: t('settings.billing.plans.free.displayName'),
    description: t('settings.billing.plans.free.description'),
    price: t('settings.billing.plans.free.price'),
    billingLabel: t('settings.billing.plans.free.billingLabel'),
    ctaLabel: t('settings.billing.plans.free.cta'),
    limits: [
      {
        value: t('settings.billing.plans.free.transcriptionValue'),
        label: t('settings.billing.plans.common.transcriptionPerMonth'),
      },
      {
        value: t('settings.billing.plans.free.seatValue'),
        label: t('settings.billing.plans.free.seat'),
      },
      {
        value: t('settings.billing.plans.free.recordingValue'),
        label: t('settings.billing.plans.common.continuousRecording'),
        tooltip: t('settings.billing.plans.common.continuousRecordingTooltip'),
      },
    ],
    features: [
      {
        text: t('settings.billing.plans.free.askAi'),
        note: t('settings.billing.plans.free.askAiNote'),
        tooltip: t('settings.billing.plans.free.askAiTooltip'),
      },
      { text: t('settings.billing.plans.free.standardModels') },
      { text: t('settings.billing.plans.free.desktopMobile') },
      { text: t('settings.billing.plans.free.notesSharing') },
      { text: t('settings.billing.plans.free.customSkills') },
      { text: t('settings.billing.plans.common.apiAccess') },
      { text: t('settings.billing.plans.common.mcpAccess') },
      { text: t('settings.billing.plans.free.communitySupport') },
    ],
  };
}

function localizePremiumPlan(plan: PlanCatalogEntry, t: ApplicationTFunction): PlanCatalogEntry {
  return {
    ...plan,
    displayName: t('settings.billing.plans.premium.displayName'),
    description: t('settings.billing.plans.premium.description'),
    price: t('settings.billing.plans.premium.price'),
    billingLabel: t('settings.billing.plans.premium.billingLabel'),
    badge: t('settings.billing.plans.premium.badge'),
    ctaLabel: t('settings.billing.plans.premium.cta'),
    checkoutOptions: plan.checkoutOptions?.map(option =>
      option.interval === 'month'
        ? {
            ...option,
            label: t('settings.billing.actions.monthly'),
            price: t('settings.billing.plans.premium.monthlyPrice'),
            billingLabel: t('settings.billing.plans.premium.monthlyBilling'),
            badge: undefined,
          }
        : {
            ...option,
            label: t('settings.billing.actions.annual'),
            price: t('settings.billing.plans.premium.annualPrice'),
            billingLabel: t('settings.billing.plans.premium.annualBilling'),
            badge: t('settings.billing.actions.save'),
          }
    ),
    limits: [
      {
        value: t('settings.billing.plans.common.unlimited'),
        label: t('settings.billing.plans.common.transcription'),
      },
      {
        value: t('settings.billing.plans.common.unlimited'),
        label: t('settings.billing.plans.common.teamMembers'),
        tooltip: t('settings.billing.plans.premium.teamMembersTooltip'),
      },
      {
        value: t('settings.billing.plans.premium.recordingValue'),
        label: t('settings.billing.plans.common.continuousRecording'),
        tooltip: t('settings.billing.plans.common.continuousRecordingTooltip'),
      },
    ],
    inherits: t('settings.billing.plans.premium.inherits'),
    features: [
      { text: t('settings.billing.plans.premium.realtimeInsights') },
      { text: t('settings.billing.plans.premium.speakerIdentification') },
      { text: t('settings.billing.plans.premium.byok') },
      { text: t('settings.billing.plans.premium.prioritySupport') },
    ],
  };
}

function localizeEnterprisePlan(plan: PlanCatalogEntry, t: ApplicationTFunction): PlanCatalogEntry {
  return {
    ...plan,
    displayName: t('settings.billing.plans.enterprise.displayName'),
    description: t('settings.billing.plans.enterprise.description'),
    price: t('settings.billing.plans.enterprise.price'),
    billingLabel: t('settings.billing.plans.enterprise.billingLabel'),
    ctaLabel: t('settings.billing.plans.enterprise.contactSales'),
    limits: [
      {
        value: t('settings.billing.plans.common.unlimited'),
        label: t('settings.billing.plans.common.transcription'),
      },
      {
        value: t('settings.billing.plans.common.unlimited'),
        label: t('settings.billing.plans.common.teamMembers'),
      },
      {
        value: t('settings.billing.plans.common.custom'),
        label: t('settings.billing.plans.enterprise.recordingLength'),
      },
    ],
    inherits: t('settings.billing.plans.enterprise.inherits'),
    features: [
      { text: t('settings.billing.plans.enterprise.premiumModels') },
      { text: t('settings.billing.plans.enterprise.bringCloud') },
      { text: t('settings.billing.plans.enterprise.bringModels') },
      { text: t('settings.billing.plans.enterprise.privateHosting') },
      { text: t('settings.billing.plans.enterprise.sso') },
      { text: t('settings.billing.plans.enterprise.licenseManagement') },
      { text: t('settings.billing.plans.enterprise.compliance') },
      {
        text: t('settings.billing.plans.enterprise.foundingSupport'),
        tooltip: t('settings.billing.plans.enterprise.foundingSupportTooltip'),
      },
    ],
  };
}

export function localizeBillingPlan(
  plan: PlanCatalogEntry,
  t: ApplicationTFunction
): PlanCatalogEntry {
  switch (plan.externalId) {
    case 'plan_free':
      return localizeFreePlan(plan, t);
    case 'plan_pro':
      return localizePremiumPlan(plan, t);
    case 'plan_enterprise':
      return localizeEnterprisePlan(plan, t);
    default:
      return plan;
  }
}

export function localizeSubscriptionState(state: string, t: ApplicationTFunction): string {
  switch (state) {
    case 'active':
      return t('settings.billing.status.active');
    case 'none':
      return t('settings.billing.status.none');
    case 'trialing':
      return t('settings.billing.status.trialing');
    default:
      return state;
  }
}
