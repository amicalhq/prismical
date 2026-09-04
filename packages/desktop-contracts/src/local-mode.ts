/**
 * Local-mode workspace identity.
 *
 * The local workspace is accountless in MAIN (the workspace lifecycle mounts
 * it with no pinned identity), but the shared renderer stack requires a
 * signed-in-shaped session and an org row to function: the sync store
 * partitions its IndexedDB by (accountSub, orgId), and the shell resolves the
 * active org against GET /apps/v1/me/organizations. These constants are that
 * ONE synthetic identity — the renderer's synthetic AuthPort session and the
 * LocalBackend's organizations/profile rows must both be built from them, or
 * useEnsureActiveOrg fires a switch-org loop against an org main doesn't know.
 *
 * The values are stable identifiers, not display-only strings: `sub`/`orgId`
 * feed the sync partition database name, so changing them orphans a local
 * profile's IndexedDB partition.
 */
export const LOCAL_WORKSPACE = {
  sub: 'local-user',
  orgId: 'local-org',
  orgUserId: 'local-org-user',
  email: 'local@prismical.app',
  name: 'Local',
  orgName: 'Local workspace',
  orgSlug: 'local',
} as const;

/**
 * The local workspace's feature flags — the "local
 * feature-flag resolver". In cloud mode a flag is an organization entitlement
 * served by the cloud backend on GET /apps/v1/me/organizations; the local
 * workspace has no organization, so it resolves its own. ONE table, two
 * consumers: the local backend serves it as the synthetic org row's `features`
 * (so query-cache readers such as the auto-pause policy agree), and the
 * renderer's capability port hands it to `useFeatureFlag` so no org round-trip
 * is needed.
 *
 * Every cloud-only surface is a flag here answering false; the keys mirror
 * app-client's CLOUD_FEATURE_DEFAULTS (which default the same keys to true
 * for a cloud org that does not emit them). Auto-pause is the one on-device
 * feature resolved locally, so it answers true.
 */
export const LOCAL_FEATURE_FLAGS: Readonly<Record<string, boolean>> = {
  account: false,
  automations: false,
  autoPauseOnSilence: true,
  billing: false,
  byokInstances: false,
  calendar: false,
  directory: false,
  eventkitCalendar: false,
  groqByok: false,
  integrations: false,
  organization: false,
  publicApi: false,
  sharing: false,
};
