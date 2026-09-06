import { Context } from 'effect';

/** The immutable workspace that owns a recording and its recovery data. */
export type RecoveryOwner =
  | { readonly mode: 'local' }
  | { readonly mode: 'cloud'; readonly sub: string; readonly orgId: string | null };

export class WorkspaceIdentity extends Context.Tag('desktop/WorkspaceIdentity')<
  WorkspaceIdentity,
  RecoveryOwner
>() {}

export const sameWorkspace = (owner: RecoveryOwner | null, current: RecoveryOwner): boolean =>
  owner !== null &&
  owner.mode === current.mode &&
  (owner.mode === 'local' ||
    (current.mode === 'cloud' && owner.sub === current.sub && owner.orgId === current.orgId));
