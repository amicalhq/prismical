/**
 * Preload fileUpload helper.
 *
 * The picked File's disk path is read here, so the page never names a path,
 * and the upload's MessagePort stays here: the page gets only a result promise
 * and a cancel function. As with openStream, the port listener is registered
 * BEFORE the invoke and removed when main answers with an error envelope (no
 * port follows one). Pure + electron-free so it is unit-testable.
 */
import {
  CHANNELS,
  fileUploadPortChannel,
  type FileUploadPortMessage,
  type FileUploadResult,
  type FileUploadStartRequest,
  type FileUploadStartResponse,
  type MainWindowDesktopApi,
} from '@prismical/desktop-contracts';
import type { OpenStreamIpc, StreamPortEvent } from './open-stream';

export interface FileUploadIpc extends Pick<OpenStreamIpc, 'once' | 'removeListener'> {
  readonly invoke: (
    channel: string,
    payload: FileUploadStartRequest
  ) => Promise<FileUploadStartResponse>;
}

export interface FileUploadDeps {
  readonly randomUUID: () => string;
  /** Electron's webUtils.getPathForFile: '' for a File that has no disk path. */
  readonly getPathForFile: (file: File) => string;
}

export const makeFileUpload =
  (ipc: FileUploadIpc, deps: FileUploadDeps): MainWindowDesktopApi['fileUpload']['put'] =>
  (request, onProgress) => {
    const filePath = deps.getPathForFile(request.file);
    if (!filePath) return { done: Promise.resolve({ ok: false, reason: 'rejected' }), cancel: () => {} };

    const uploadId = deps.randomUUID();
    const portChannel = fileUploadPortChannel(uploadId);
    let port: MessagePort | null = null;
    let cancelled = false;
    let resolve!: (result: FileUploadResult) => void;
    const done = new Promise<FileUploadResult>(settle => {
      resolve = settle;
    });
    // Only the first result counts; closing a closed port does nothing.
    const finish = (result: FileUploadResult): void => {
      port?.close();
      resolve(result);
    };

    const onPort = (event: StreamPortEvent): void => {
      const received = event.ports[0];
      if (received === undefined) {
        finish({ ok: false, reason: 'interrupted' });
        return;
      }
      port = received;
      received.onmessage = (message: MessageEvent<FileUploadPortMessage>) => {
        if (message.data.type === 'progress') onProgress(message.data.percent);
        else finish(message.data.result);
      };
      if (cancelled) received.postMessage({ type: 'cancel' });
    };
    ipc.once(portChannel, onPort);

    ipc
      .invoke(CHANNELS.fileUploadStart, {
        uploadId,
        url: request.url,
        filePath,
        contentType: request.contentType,
      })
      .then(
        response => {
          if ('error' in response) {
            ipc.removeListener(portChannel, onPort);
            finish({ ok: false, reason: 'rejected' });
          }
        },
        () => {
          ipc.removeListener(portChannel, onPort);
          finish({ ok: false, reason: 'interrupted' });
        }
      );

    return {
      done,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        port?.postMessage({ type: 'cancel' });
      },
    };
  };
