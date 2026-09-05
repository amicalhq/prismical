import { describe, expect, it } from 'vitest';
import { ApiErrorResponseSchema } from '../../error.js';
import {
  AppsV1ErrorResponseSchema,
  MeResponseSchema,
  PlanAccessSchema,
  PlanDetailsSchema,
  PlanCheckoutRequestSchema,
  PlanSummarySchema,
  SyncListResponseSchema,
  SyncWriteResponseSchema,
  UsageResponseSchema,
  ViewerProfileResponseSchema,
  InstanceModelsResponseSchema,
  NotePublicationStateResponseSchema,
  syncListQuerySchema,
  type ParsedPlanCheckoutRequest,
  type PlanCheckoutRequest,
} from './index.js';

describe('apps/v1 contracts', () => {
  it('preserves domain error details alongside correlation fields', () => {
    const body = {
      error: {
        code: 'TITLE_CHANGED',
        message: 'Title changed',
        traceId: 'trace_1',
        requestId: 'request_1',
        localizedMessage: { locale: 'fr', message: 'Le titre a changé' },
        details: {
          retryable: false,
          user: { title: 'Le titre a changé', severity: 'warning', actions: [] },
        },
      },
    };
    expect(AppsV1ErrorResponseSchema.parse(body)).toEqual(body);
    expect(AppsV1ErrorResponseSchema.parse({ error: { ...body.error, id: 'old' } })).toEqual(body);
    expect(AppsV1ErrorResponseSchema.safeParse({ error: { code: 'NOT_FOUND' } }).success).toBe(
      false
    );
    expect(
      AppsV1ErrorResponseSchema.safeParse({ error: 'Not found', code: 'NOT_FOUND' }).success
    ).toBe(false);
  });
  it('returns a single resource directly and rejects its old wrapper', () => {
    const profile = { id: 'usr_1', name: 'Ada', email: 'ada@example.com', image: null };
    expect(ViewerProfileResponseSchema.parse(profile)).toEqual(profile);
    expect(ViewerProfileResponseSchema.safeParse({ result: profile }).success).toBe(false);
  });

  it('uses results for a standard list without a success flag', () => {
    const models = [{ id: 'model_1', name: 'Model', type: 'language' }];
    expect(InstanceModelsResponseSchema.parse({ results: models })).toEqual({ results: models });
    expect(InstanceModelsResponseSchema.safeParse({ success: true, models }).success).toBe(false);
  });

  it('keeps composite response fields together without a result layer', () => {
    const state = { publishedAt: null, allowPublicSharing: true };
    expect(NotePublicationStateResponseSchema.parse(state)).toEqual(state);
  });

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
    expect(SyncListResponseSchema.parse({ results: [row] })).toEqual({
      results: [row],
    });
    expect(SyncWriteResponseSchema.parse({ result: row, applied: true, created: true })).toEqual({
      result: row,
      applied: true,
      created: true,
    });
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

  it('keeps the existing public error schema unchanged', () => {
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
