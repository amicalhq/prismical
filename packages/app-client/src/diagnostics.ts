/** Optional shell diagnostics. Reporting must never change product behavior. */
export interface ClientDiagnostics {
  captureException(error: unknown, properties?: Record<string, string | number | undefined>): void;
  requestHeaders?(): Record<string, string>;
}

let diagnostics: ClientDiagnostics | undefined;
export function configureClientDiagnostics(value?: ClientDiagnostics): void {
  diagnostics = value;
}

export function reportClientError(
  error: unknown,
  properties?: Record<string, string | number | undefined>,
): void {
  try {
    if (error instanceof Error && error.name === "AbortError") return;
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) return;
    diagnostics?.captureException(error, properties);
  } catch {
    // Analytics is optional, including when its own SDK fails.
  }
}

export function diagnosticHeaders(): Record<string, string> {
  try {
    return diagnostics?.requestHeaders?.() ?? {};
  } catch {
    return {};
  }
}
