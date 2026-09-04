// TransportPort — the unary REST lane shared by the renderers.
//
// Mirrors the desktop IPC envelope (packages/desktop-contracts/
// src/main-window.ts TransportRequest/TransportResponse) field-for-field —
// types only, no zod (app-contracts is runtime-dep-free; desktop-contracts
// pins zod 3, the catalog is zod 4). The desktop adapter forwards to
// `window.desktop.transport.request` untouched; the web adapter maps fetch onto
// the same envelope: ANY completed HTTP exchange —
// including 4xx/5xx — is `{ ok: true, status, bodyJson }`; the error arm is
// reserved for transport-layer failure (network, disallowed path). Ask
// streaming is NOT this port — it crosses on the AI-SDK transport shim.

export type TransportMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface TransportRequest {
  readonly method: TransportMethod;
  /** Core API path (desktop lane allows only /apps/v1/me and descendants). */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** JSON-serializable body. */
  readonly body?: unknown;
}

export type TransportErrorCode =
  | "INVALID_REQUEST"
  | "PATH_NOT_ALLOWED"
  | "UNKNOWN_SENDER"
  | "INTERNAL";

export type TransportResponse =
  | { readonly ok: true; readonly status: number; readonly bodyJson: unknown }
  | {
      readonly error: {
        readonly code: TransportErrorCode;
        readonly message?: string;
      };
    };

export interface TransportPort {
  request(request: TransportRequest): Promise<TransportResponse>;
}
