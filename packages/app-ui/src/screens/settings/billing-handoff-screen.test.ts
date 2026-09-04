import { describe, expect, it } from 'vitest';
import { canManageOrganizationBilling, webBillingUrl } from './billing-handoff-screen';

describe('desktop billing handoff helpers', () => {
  it('allows only organization roles that can manage billing', () => {
    expect(canManageOrganizationBilling('owner')).toBe(true);
    expect(canManageOrganizationBilling('admin')).toBe(true);
    expect(canManageOrganizationBilling('member')).toBe(false);
    expect(canManageOrganizationBilling(undefined)).toBe(false);
  });

  it('builds the canonical billing destination without inheriting an origin path', () => {
    expect(webBillingUrl('https://app.prismical.ai/old/path')).toBe(
      'https://app.prismical.ai/settings/billing'
    );
  });
});
