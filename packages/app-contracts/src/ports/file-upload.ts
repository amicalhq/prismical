// FileUploadPort — sends one picked file to a storage upload URL that core returned.
//
// Optional: a platform that omits it gets the shared in-page XHR upload (web). The
// desktop renderer's CSP keeps network traffic in main, so desktop supplies this port
// and main sends the file.

/** Why an upload did not finish: stopped by the caller, lost or stalled, or refused by storage. */
export type FileUploadFailure = 'cancelled' | 'interrupted' | 'rejected';

export type FileUploadResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: FileUploadFailure };

export interface FileUploadRequest {
  readonly url: string;
  readonly file: File;
  readonly contentType: string;
  /** Whole percentages of the file sent. */
  readonly onProgress: (percent: number) => void;
  /** Aborting stops the transfer; the result is then `cancelled`. */
  readonly signal: AbortSignal;
}

export interface FileUploadPort {
  /** Never rejects: every outcome is a result. */
  put(request: FileUploadRequest): Promise<FileUploadResult>;
}
