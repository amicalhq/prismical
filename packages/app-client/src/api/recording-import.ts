'use client';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { RecordingImportResponse } from '@prismical/api-contracts/apps/v1';
import type { FileUploadFailure, FileUploadPort } from '@prismical/app-contracts';
import { EVENTS } from '../analytics-events';
import { useOrganizations } from './hooks/organizations';
import { usePorts } from '../ports-context';
import { useSessionView } from '../ports-context';
import { apiClient, ME_PREFIX } from './client';
import { coreApiBaseUrl } from '../runtime';
import { getAuthHeadersForToken } from './auth';

export type AudioImportState = {
  ownerKey: string;
  orgId: string;
  noteId: string;
  progress: number;
  record: RecordingImportResponse | null;
  error: string | null;
  busy: boolean;
  canCancel?: boolean;
  /** Recovered server state has no local file transfer to coordinate with capture. */
  observedOnly?: boolean;
  canComplete?: boolean;
};
let state: AudioImportState | null = null;
let transfer: AbortController | null = null;
let revision = 0;
let abandonUpload: (() => void) | null = null;
const listeners = new Set<() => void>();
const emit = (next: AudioImportState | null) => {
  state = next;
  for (const fn of listeners) fn();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const root = `${ME_PREFIX}/recording-imports`;
const terminal = (r: RecordingImportResponse) => ['done', 'failed', 'cancelled'].includes(r.status);
const uploadErrors = {
  cancelled: 'audioImport.cancelled',
  interrupted: 'audioImport.interrupted',
  rejected: 'audioImport.uploadFailed',
} as const satisfies Record<FileUploadFailure, string>;
/** The in-page upload, used when the platform supplies no FileUploadPort. */
const xhrUpload: FileUploadPort = {
  put: ({ url, file, contentType, onProgress, signal }) =>
    new Promise(resolve => {
      const request = new XMLHttpRequest();
      request.open('PUT', url);
      request.timeout = 30 * 60_000;
      request.ontimeout = () => resolve({ ok: false, reason: 'interrupted' });
      request.setRequestHeader('Content-Type', contentType);
      request.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      request.onload = () =>
        resolve(
          request.status >= 200 && request.status < 300
            ? { ok: true }
            : { ok: false, reason: 'rejected' }
        );
      request.onerror = () => resolve({ ok: false, reason: 'interrupted' });
      request.onabort = () => resolve({ ok: false, reason: 'cancelled' });
      signal.addEventListener('abort', () => request.abort(), { once: true });
      request.send(file);
    }),
};

/** One shell transfer, independent of the note panel's mount/navigation lifecycle. */
export function useAudioImport(enabled = false) {
  const { t } = useTranslation();
  const { auth, analytics, env, fileUpload = xhrUpload } = usePorts();
  const organizations = useOrganizations();
  const session = useSessionView();
  const ownerKey = session.activeSessionKey ?? session.activeSub ?? '';
  const account = session.accounts.find(a => (a.sessionKey ?? a.sub) === ownerKey);
  const orgId = account?.activeOrgId ?? '';
  const expectedOrgUserId = organizations.data?.find(o => o.orgId === orgId)?.orgUserId;
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => null
  );
  const matches = useCallback(() => {
    const s = auth.getSession();
    const key = s.activeSessionKey ?? s.activeSub;
    return (
      key === ownerKey &&
      s.accounts.find(a => (a.sessionKey ?? a.sub) === key)?.activeOrgId === orgId
    );
  }, [auth, ownerKey, orgId]);
  useEffect(() => {
    if (!enabled) return;
    // A session can change while the shell is unmounted (sign-out/navigation).
    if (state && (state.ownerKey !== ownerKey || state.orgId !== orgId)) {
      abandonUpload?.();
      abandonUpload = null;
      revision++;
      transfer?.abort();
      transfer = null;
      emit(null);
    }
    const abandon = () => {
      abandonUpload?.();
    };
    window.addEventListener('pagehide', abandon);
    const unsubscribe = auth.onSessionChanged(() => {
      if (state && !matches()) {
        abandonUpload?.();
        abandonUpload = null;
        revision++;
        transfer?.abort();
        transfer = null;
        emit(null);
      }
    });
    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', abandon);
    };
  }, [enabled, auth, matches, ownerKey, orgId]);
  const monitor = useCallback(
    async (initial: RecordingImportResponse, version: number) => {
      let record = initial;
      let failures = 0;
      while (!terminal(record) && version === revision && matches()) {
        await new Promise(resolve =>
          setTimeout(
            resolve,
            Math.min(30_000, (record.status === 'uploading' ? 5000 : 2000) * 2 ** failures)
          )
        );
        if (version !== revision || !matches()) return;
        try {
          record = await apiClient.get<RecordingImportResponse>(
            `${root}/${record.recordingId}`,
            undefined,
            { activeOrgId: orgId }
          );
        } catch (error) {
          const status = (error as { status?: number }).status;
          failures++;
          if (
            (status === 401 || status === 403 || status === 404 || failures >= 5) &&
            state &&
            version === revision
          ) {
            emit({
              ...state,
              busy: false,
              error: t('audioImport.reconnect'),
            });
            return;
          }
          continue;
        }
        failures = 0;
        if (version === revision && matches())
          emit({
            canCancel: record.status === 'uploading' && state?.canCancel,
            observedOnly: state?.observedOnly,
            canComplete: record.status === 'uploading' && state?.canComplete,
            ownerKey,
            orgId,
            noteId: record.noteId,
            record,
            progress: record.status === 'uploading' ? (state?.progress ?? 0) : 100,
            error:
              record.status === 'uploading' && (state?.canComplete || state?.canCancel)
                ? (state.error ?? record.error)
                : record.error,
            busy: !terminal(record),
          });
      }
    },
    [matches, ownerKey, orgId, t]
  );
  useEffect(() => {
    if (!enabled || !ownerKey || !orgId || state?.busy) return;
    let mounted = true;
    void apiClient
      .get<RecordingImportResponse | null>(`${root}/active`, undefined, { activeOrgId: orgId })
      .then(record => {
        if (!mounted || !record || !matches() || state?.busy) return;
        const version = ++revision;
        emit({
          ownerKey,
          orgId,
          noteId: record.noteId,
          record,
          progress: 0,
          error: record.error,
          observedOnly: true,
          busy: true,
        });
        void monitor(record, version);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [enabled, ownerKey, orgId, matches, monitor]);
  const start = async (noteId: string, file: File, language: string, restartId?: string) => {
    if (!enabled) return;
    if (state?.busy) throw new Error(t('audioImport.busy'));
    if (!matches() || !expectedOrgUserId) throw new Error(t('audioImport.loading'));
    const version = ++revision;
    emit({ ownerKey, orgId, noteId, record: null, progress: 0, error: null, busy: true });
    const requestKey = crypto.randomUUID();
    let stage = 'create';
    const track = (outcome: string) => {
      try {
        analytics?.capture(EVENTS.AUDIO_IMPORT_UPLOAD, {
          outcome,
          stage,
          size_bytes: file.size,
          restart: Boolean(restartId),
        });
      } catch {
        /* Analytics must never interrupt an upload. */
      }
    };
    let bound: { activeOrgId: string; authToken?: string } = { activeOrgId: orgId };
    try {
      const authToken = await auth.getTokenForSession(ownerKey, orgId);
      if (version !== revision || !matches()) return;
      if (!authToken) throw new Error(t('audioImport.signIn'));
      bound = { activeOrgId: orgId, authToken };
      const create = async () =>
        restartId
          ? await apiClient.post<RecordingImportResponse>(
              `${root}/${restartId}/restart-upload`,
              { fileName: file.name, sizeBytes: file.size },
              bound
            )
          : await apiClient.post<RecordingImportResponse>(
              root,
              {
                noteId,
                expectedOrgUserId,
                requestKey,
                fileName: file.name,
                sizeBytes: file.size,
                language,
              },
              bound
            );
      // Retry only the idempotent create, using the same request key after an ambiguous response.
      // No status (a web network failure) or 0 (a desktop transport failure) is ambiguous too.
      const record = await create().catch(error => {
        const status = (error as { status?: number }).status ?? 0;
        if (restartId || (status > 0 && status < 500) || version !== revision || !matches())
          throw error;
        return create();
      });
      const cancelBound = () => {
        if (env.getEnv().platform !== 'web') {
          // IPC uses main's active account, not the web token override. Do not send
          // an old account's cancellation after a switch; upload expiry is the backstop.
          if (!matches()) return;
          void apiClient.post(`${root}/${record.recordingId}/cancel`, {
            uploadAttempt: record.uploadAttempt,
          }, bound).catch(() => {});
          return;
        }
        void fetch(`${coreApiBaseUrl()}${root}/${record.recordingId}/cancel`, {
          method: 'POST',
          keepalive: true,
          headers: {
            ...getAuthHeadersForToken(authToken, orgId),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ uploadAttempt: record.uploadAttempt }),
        }).catch(() => {});
      };
      if (version !== revision || !matches()) {
        cancelBound();
        return;
      }
      abandonUpload = cancelBound;
      emit({
        ownerKey,
        orgId,
        noteId,
        record,
        progress: 0,
        error: null,
        busy: true,
        canCancel: true,
      });
      if (!record.uploadUrl) throw new Error(t('audioImport.sessionUnavailable'));
      stage = 'upload';
      track('started');
      const controller = new AbortController();
      transfer = controller;
      const uploaded = await fileUpload.put({
        url: record.uploadUrl,
        file,
        contentType: file.type || 'application/octet-stream',
        signal: controller.signal,
        onProgress: progress => {
          if (version === revision && state) emit({ ...state, progress });
        },
      });
      if (transfer === controller) transfer = null;
      if (!uploaded.ok) throw new Error(t(uploadErrors[uploaded.reason]));
      if (version !== revision || !matches()) return;
      track('completed');
      stage = 'complete';
      // Once GCS has committed, let server recovery finish even if the tab closes.
      abandonUpload = null;
      if (state) emit({ ...state, canComplete: true });
      const completed = await apiClient.post<RecordingImportResponse>(
        `${root}/${record.recordingId}/complete`,
        { uploadAttempt: record.uploadAttempt },
        bound
      );
      if (version !== revision || !matches()) return;
      emit({
        ownerKey,
        orgId,
        noteId,
        record: completed,
        progress: 100,
        error: null,
        busy: !terminal(completed),
      });
      void monitor(completed, version);
    } catch (error) {
      if (version === revision && matches() && state) {
        track('failed');
        emit({
          ...state,
          error: error instanceof Error ? error.message : t('audioImport.failed'),
          busy: Boolean(state.record && !terminal(state.record)),
        });
        if (!state.record) {
          const recovered = await apiClient
            .get<RecordingImportResponse | null>(`${root}/active`, undefined, bound)
            .catch(() => null);
          if (recovered && version === revision && matches())
            emit({
              ownerKey,
              orgId,
              noteId: recovered.noteId,
              record: recovered,
              progress: 0,
              error: recovered.error,
              observedOnly: true,
              canCancel:
                !restartId &&
                recovered.status === 'uploading' &&
                recovered.requestKey === requestKey,
              busy: true,
            });
        }
        if (state?.record) void monitor(state.record, version);
      }
    }
  };
  const cancel = async () => {
    const record = state?.record;
    if (!enabled || !record || !matches() || !state?.canCancel) return;
    transfer?.abort();
    transfer = null;
    const version = ++revision;
    abandonUpload = null;
    try {
      const result = await apiClient.post<RecordingImportResponse>(
        `${root}/${record.recordingId}/cancel`,
        { uploadAttempt: record.uploadAttempt },
        { activeOrgId: orgId }
      );
      if (version === revision && matches())
        emit({
          ownerKey,
          orgId,
          noteId: result.noteId,
          record: result,
          progress: 0,
          error: null,
          busy: false,
        });
    } catch {
      const result = await apiClient.get<RecordingImportResponse>(
        `${root}/${record.recordingId}`,
        undefined,
        { activeOrgId: orgId }
      );
      if (version === revision && matches()) {
        emit({
          ownerKey,
          orgId,
          noteId: result.noteId,
          record: result,
          progress: 100,
          error: result.error,
          busy: !terminal(result),
        });
        void monitor(result, revision);
      }
    }
  };
  const retry = async (id: string) => {
    if (!enabled || state?.busy || !matches()) return;
    const version = ++revision;
    const previous = state;
    emit({
      ownerKey,
      orgId,
      noteId: previous?.noteId ?? '',
      record: previous?.record ?? null,
      progress: 100,
      error: null,
      busy: true,
    });
    let record: RecordingImportResponse;
    try {
      record = await apiClient.post<RecordingImportResponse>(
        `${root}/${id}/retry`,
        {},
        { activeOrgId: orgId }
      );
    } catch (error) {
      if (version === revision && matches()) emit(previous);
      throw error;
    }
    if (!matches() || version !== revision) return;
    emit({
      ownerKey,
      orgId,
      noteId: record.noteId,
      record,
      progress: 100,
      error: null,
      busy: true,
    });
    void monitor(record, version);
  };
  const complete = async () => {
    const record = state?.record;
    if (!enabled || !record || !state?.canComplete || !matches()) return;
    const version = ++revision;
    try {
      const result = await apiClient.post<RecordingImportResponse>(
        `${root}/${record.recordingId}/complete`,
        { uploadAttempt: record.uploadAttempt },
        { activeOrgId: orgId }
      );
      if (version !== revision || !matches()) return;
      emit({
        ownerKey,
        orgId,
        noteId: result.noteId,
        record: result,
        progress: 100,
        error: result.error,
        busy: !terminal(result),
      });
    } finally {
      if (version === revision && matches() && state?.record) void monitor(state.record, version);
    }
  };
  return {
    state: enabled && current?.ownerKey === ownerKey && current.orgId === orgId ? current : null,
    start,
    cancel,
    retry,
    complete,
  };
}
