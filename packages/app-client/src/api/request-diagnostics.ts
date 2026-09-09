// Only known static route segments may enter telemetry. Unknown segments (including
// resource IDs, emails and encoded values) are redacted; queries never leave here.
const staticSegments = new Set([
  "apps", "v1", "me", "notes", "folders", "tags", "note-tags", "note-events",
  "recordings", "enhanced-recordings", "skill-runs", "pending", "accept", "resolve",
  "restore", "skills", "run", "title-runs", "apply", "undo", "profile", "usage",
  "organizations", "connections", "calendars", "events", "instances", "models",
  "model-defaults", "ask", "conversations", "messages", "plan", "checkout", "portal",
  "automations", "automation-runs", "runs", "retry", "secret", "rotate-secret",
  "api-keys", "mcp-servers", "authorize", "test", "people", "companies", "vocabulary",
  "team-vocabulary", "eventkit", "integration", "sync", "content",
]);

export function safeApiRoute(path: string): string {
  // Unexpected absolute URLs and excessively long paths are never recorded.
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 2048) return "[redacted]";
  return path.split(/[?#]/, 1)[0]!.split("/")
    .map((segment) => !segment || staticSegments.has(segment) ? segment : ":redacted")
    .join("/");
}

export function clientRequestId(): string | undefined {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    // Missing crypto must not prevent a request.
    return undefined;
  }
}
