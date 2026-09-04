import { describe, expect, it } from 'vitest';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import type { PlanCatalogEntry } from '@prismical/app-client';
import { localizeBillingPlan } from './billing-plan-presentation';

function plan(externalId: string): PlanCatalogEntry {
  return {
    externalId,
    displayName: 'Server name',
    description: 'Server description',
    price: '$10/mo',
    billingLabel: 'Server billing label',
    perUser: false,
    checkoutEligible: false,
    contactSales: false,
    ctaLabel: 'Server action',
    sortOrder: 1,
    limits: [],
    features: [],
  };
}

describe('billing plan presentation', () => {
  it('localizes every launch plan from its stable external id', () => {
    const i18n = createApplicationI18nSync('de');

    expect(localizeBillingPlan(plan('plan_free'), i18n.t).displayName).toBe('Kostenlos');
    expect(localizeBillingPlan(plan('plan_pro'), i18n.t).displayName).toBe('Premium');
    expect(localizeBillingPlan(plan('plan_enterprise'), i18n.t).displayName).toBe('Enterprise');
  });

  it('preserves server copy for an unknown future plan', () => {
    const i18n = createApplicationI18nSync('ja');

    expect(localizeBillingPlan(plan('plan_future'), i18n.t)).toEqual(plan('plan_future'));
  });
});
