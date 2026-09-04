import { describe, expect, it } from 'vitest';
import { ApiErrorResponseSchema } from '../../error.js';
import {
  MeResponseSchema,
  PlanAccessSchema,
  PlanDetailsSchema,
  PlanCheckoutRequestSchema,
  PlanSummarySchema,
  SyncListResponseSchema,
  SyncWriteResponseSchema,
  UsageResponseSchema,
  syncListQuerySchema,
  type ParsedPlanCheckoutRequest,
  type PlanCheckoutRequest,
} from './index.js';

describe('apps/v1 contracts', () => {
  it('defines /me.plan as a summary of /me/plan.plan', () => {
    const planDetails = PlanDetailsSchema.parse({
      id: 'pln_pro',
      isFreeTier: false,
      displayName: 'Premium',
      externalId: 'plan_pro',
      status: 'active',
      source: 'revenuecat',
      trialEndsAt: null,
      inclusions: { dictation_words: null, scope: 'user' },
    });

    expect(MeResponseSchema.shape.plan).toBe(PlanSummarySchema);
    expect(PlanAccessSchema.shape.plan).toBe(PlanDetailsSchema);
    expect(PlanSummarySchema.parse(planDetails)).toEqual({
      isFreeTier: false,
      displayName: 'Premium',
      externalId: 'plan_pro',
      status: 'active',
      source: 'revenuecat',
      trialEndsAt: null,
    });
    expect(
      PlanSummarySchema.safeParse({
        isFreeTier: true,
        displayName: null,
        externalId: null,
        status: 'none',
        source: null,
        trialEndsAt: null,
      }).success
    ).toBe(false);
  });

  it('applies the checkout billing interval default', () => {
    const request: PlanCheckoutRequest = { planExternalId: 'plan_pro' };
    const parsed: ParsedPlanCheckoutRequest = PlanCheckoutRequestSchema.parse(request);
    expect(parsed).toEqual({ planExternalId: 'plan_pro', billingInterval: 'month' });
  });

  it('rejects unknown checkout fields', () => {
    expect(
      PlanCheckoutRequestSchema.safeParse({
        planExternalId: 'plan_pro',
        billingIntervl: 'year',
      }).success
    ).toBe(false);
  });

  it('keeps Prismical sync envelopes generic without dropping row fields', () => {
    const row = { id: 'tag_1', name: 'Work', updatedAt: '2030-01-01T00:00:00.000Z' };
    expect(SyncListResponseSchema.parse({ success: true, results: [row] })).toEqual({
      success: true,
      results: [row],
    });
    expect(
      SyncWriteResponseSchema.parse({ success: true, result: row, applied: true, created: true })
    ).toEqual({ success: true, result: row, applied: true, created: true });
  });

  it('builds entity-specific sync query schemas', () => {
    expect(
      syncListQuerySchema(['noteId']).parse({
        since: '2030-01-01T00:00:00.000Z',
        includeDeleted: '1',
        noteId: 'nt_1',
        ignored: 'value',
      })
    ).toEqual({
      since: '2030-01-01T00:00:00.000Z',
      includeDeleted: '1',
      noteId: 'nt_1',
    });
  });

  it('shares the nested error envelope and strips additive fields', () => {
    expect(
      ApiErrorResponseSchema.parse({
        error: {
          id: 'trace_1',
          code: 'NOT_FOUND',
          message: 'Not found',
          details: { entity: 'tag' },
          futureErrorField: true,
        },
        futureResponseField: true,
      })
    ).toEqual({
      error: {
        id: 'trace_1',
        code: 'NOT_FOUND',
        message: 'Not found',
        details: { entity: 'tag' },
      },
    });
  });

  it('rejects malformed endpoint responses', () => {
    expect(MeResponseSchema.safeParse({ userId: 'usr_1' }).success).toBe(false);
    expect(UsageResponseSchema.safeParse({ success: true, result: { usage: {} } }).success).toBe(
      false
    );
  });
});
