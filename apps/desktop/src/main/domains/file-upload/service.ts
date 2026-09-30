import type { MessagePortMain } from 'electron';
import { Context, Data, type Effect } from 'effect';

export class FileUploadError extends Data.TaggedError('FileUploadError')<{
  readonly code: 'NOT_GRANTED' | 'DUPLICATE_UPLOAD';
}> {}

/** Minimal sender surface the broker needs (event.sender in production). */
export interface FileUploadSender {
  readonly postMessage: (channel: string, message: unknown, transfer?: MessagePortMain[]) => void;
}

/**
 * Imported-file upload lane. The renderer cannot reach storage, so main sends
 * the picked file. `grant` records an upload URL that a core recording-import
 * response returned; `start` sends only to a granted URL, and each grant is
 * used once. Progress and the result go to the sender on a per-upload
 * MessagePort; a `cancel` message or the port closing stops the transfer.
 * A port that closes first means the page went away without `pagehide` (a
 * destroyed window), so the grant's `abandon` cancels the import on core.
 * The URL (a storage credential) and the file path are never logged.
 */
export interface FileUploadBrokerApi {
  readonly grant: (url: string, abandon: Effect.Effect<void>) => Effect.Effect<void>;
  readonly start: (args: {
    readonly uploadId: string;
    readonly url: string;
    readonly filePath: string;
    readonly contentType: string;
    readonly sender: FileUploadSender;
  }) => Effect.Effect<void, FileUploadError>;
}

export class FileUploadBroker extends Context.Service<FileUploadBroker, FileUploadBrokerApi>()(
  'desktop/FileUploadBroker'
) {}
