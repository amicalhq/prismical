import { planAttributes } from '../../../../shared/plan-attributes';

export type ChatIdentity = {
  userId: string;
  orgId?: string;
  name?: string;
  email?: string;
  planExternalId: string | null;
} | null;

type ChatSdk = Pick<
  typeof import('gleap').default,
  'identify' | 'updateContact' | 'clearIdentity' | 'getIdentity'
>;

export const chatOwnerKey = (identity: ChatIdentity) =>
  JSON.stringify([identity?.userId ?? null, identity?.orgId ?? null]);

const contactFor = (identity: NonNullable<ChatIdentity>) => ({
  name: identity.name,
  email: identity.email,
  plan: identity.planExternalId,
  customData: identity.planExternalId === null ? null : planAttributes(identity.planExternalId),
});

/** Serialize identity mutations; the provider retains ownership of the SDK lifecycle. */
export function createChatIdentitySync(
  sdk: ChatSdk,
  setReadyOwner: (key: string | undefined) => void
) {
  let desired: ChatIdentity | undefined;
  let applied: ChatIdentity | undefined;
  let running = false;
  let uncertain = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const signature = (identity: ChatIdentity | undefined) => JSON.stringify(identity);
  const publishReady = () =>
    setReadyOwner(
      desired !== undefined &&
        applied !== undefined &&
        chatOwnerKey(desired) === chatOwnerKey(applied)
        ? chatOwnerKey(applied)
        : undefined
    );

  async function drain() {
    if (running || desired === undefined) return;
    running = true;
    let attempted = desired;
    try {
      while (desired !== undefined && (uncertain || signature(desired) !== signature(applied))) {
        attempted = desired;
        const previousId = applied?.userId ?? sdk.getIdentity()?.userId;
        if (previousId && previousId !== attempted?.userId) sdk.clearIdentity();
        if (attempted !== null) {
          // These SDK methods return promises at runtime despite their void typings.
          if (previousId === attempted.userId) await sdk.updateContact(contactFor(attempted));
          else await sdk.identify(attempted.userId, contactFor(attempted));
        }
        applied = attempted;
        uncertain = false;
        failures = 0;
      }
      if (desired === undefined) {
        sdk.clearIdentity();
        applied = undefined;
      }
      publishReady();
    } catch {
      // A lost response may have applied metadata. Reconcile even if the desired
      // value changed back to the last confirmed value while the request ran.
      uncertain = true;
      // A metadata retry is idempotent and must not log out an already identified contact.
      if (applied === undefined || chatOwnerKey(applied) !== chatOwnerKey(attempted)) {
        sdk.clearIdentity();
        applied = undefined;
      }
      publishReady();
      if (desired === undefined) return;
      const delay = Math.min(1_000 * 2 ** Math.min(failures++, 5), 30_000);
      retry = setTimeout(
        () => {
          retry = undefined;
          void drain();
        },
        signature(attempted) === signature(desired) ? delay : 0
      );
    } finally {
      running = false;
    }
  }

  return {
    setIdentity(identity: ChatIdentity) {
      desired = identity;
      publishReady();
      clearTimeout(retry);
      retry = undefined;
      void drain();
    },
    suspend() {
      desired = undefined;
      applied = undefined;
      uncertain = false;
      publishReady();
      clearTimeout(retry);
      retry = undefined;
    },
  };
}
