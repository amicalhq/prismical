import type { TransportRequest, TransportResponse } from '@prismical/desktop-contracts';

const IMPORTS_PATH = '/apps/v1/me/recording-imports';
/** A core id: no `%`, `?`, `#` or `/`, so a matched path is the path fetch requests. */
const ID = '[A-Za-z0-9_-]+';
/** The import calls whose response carries a new storage upload URL: create and restart. */
const UPLOAD_SESSION_PATH = new RegExp(`^${IMPORTS_PATH}(?:/${ID}/restart-upload)?$`);
const SAFE_ID = new RegExp(`^${ID}$`);

export interface UploadGrant {
  readonly url: string;
  /** Cancels the import on core, as the account that created it. */
  readonly cancel: TransportRequest;
}

/**
 * What a successful import create or restart grants: its storage upload URL,
 * and the cancel request main sends if the page goes away mid-upload. Null for
 * every other exchange. The transport lane grants exactly these URLs.
 */
export const importUploadGrant = (
  request: TransportRequest,
  response: TransportResponse
): UploadGrant | null => {
  if (request.method !== 'POST' || !UPLOAD_SESSION_PATH.test(request.path)) return null;
  if (!('ok' in response) || response.status < 200 || response.status >= 300) return null;
  const body = response.bodyJson;
  if (typeof body !== 'object' || body === null) return null;
  const { uploadUrl, recordingId, uploadAttempt } = body as Record<string, unknown>;
  if (
    typeof uploadUrl !== 'string' ||
    typeof recordingId !== 'string' ||
    !SAFE_ID.test(recordingId) ||
    typeof uploadAttempt !== 'string'
  )
    return null;
  return {
    url: uploadUrl,
    cancel: {
      method: 'POST',
      path: `${IMPORTS_PATH}/${recordingId}/cancel`,
      body: { uploadAttempt },
      ...(request.expectedAccountId === undefined
        ? {}
        : { expectedAccountId: request.expectedAccountId }),
    },
  };
};
