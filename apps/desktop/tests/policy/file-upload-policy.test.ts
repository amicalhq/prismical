import { describe, expect, it } from 'vitest';
import type { TransportRequest, TransportResponse } from '@prismical/desktop-contracts';
import { importUploadGrant } from '../../src/main/domains/file-upload/policy';

const UPLOAD_URL = 'https://storage.test/upload?upload_id=abc';
const RECORD = { recordingId: 'rec_1', uploadAttempt: 'attempt-1', uploadUrl: UPLOAD_URL };
const ok = (bodyJson: unknown, status = 201): TransportResponse => ({ ok: true, status, bodyJson });
const post = (path: string): TransportRequest => ({ method: 'POST', path, expectedAccountId: 'sub_a' });

describe('importUploadGrant', () => {
  it.each([
    '/apps/v1/me/recording-imports',
    '/apps/v1/me/recording-imports/rec_1/restart-upload',
  ])('grants the upload URL and a pinned cancel for an import create or restart (%s)', path => {
    expect(importUploadGrant(post(path), ok(RECORD))).toEqual({
      url: UPLOAD_URL,
      cancel: {
        method: 'POST',
        path: '/apps/v1/me/recording-imports/rec_1/cancel',
        body: { uploadAttempt: 'attempt-1' },
        expectedAccountId: 'sub_a',
      },
    });
  });

  it.each<[string, TransportRequest, TransportResponse]>([
    ['another path', post('/apps/v1/me/notes'), ok(RECORD)],
    ['a read', { method: 'GET', path: '/apps/v1/me/recording-imports' }, ok(RECORD, 200)],
    ['another import action', post('/apps/v1/me/recording-imports/rec_1/cancel'), ok(RECORD)],
    ['a nested restart path', post('/apps/v1/me/recording-imports/a/b/restart-upload'), ok(RECORD)],
    // fetch would normalize or cut these, so the request goes to another route.
    ['an encoded dot segment', post('/apps/v1/me/recording-imports/%2e%2e/restart-upload'), ok(RECORD)],
    ['a query in the id', post('/apps/v1/me/recording-imports/x?/restart-upload'), ok(RECORD)],
    ['an error status', post('/apps/v1/me/recording-imports'), ok(RECORD, 409)],
    ['a transport error', post('/apps/v1/me/recording-imports'), { error: { code: 'INTERNAL' } }],
    ['no upload URL', post('/apps/v1/me/recording-imports'), ok({ ...RECORD, uploadUrl: null })],
    ['an unsafe recording id', post('/apps/v1/me/recording-imports'), ok({ ...RECORD, recordingId: '../x' })],
    ['no upload attempt', post('/apps/v1/me/recording-imports'), ok({ ...RECORD, uploadAttempt: 1 })],
    ['a non-object body', post('/apps/v1/me/recording-imports'), ok('text')],
  ])('grants nothing for %s', (_name, request, response) => {
    expect(importUploadGrant(request, response)).toBeNull();
  });
});
