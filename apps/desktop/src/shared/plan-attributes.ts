/** Resolved organization plan facts used by analytics and support. */
export function planAttributes(planExternalId: string) {
  const tier = /^plan_appsumo_tier_(\d+)$/.exec(planExternalId)?.[1];
  return {
    plan_external_id: planExternalId,
    is_appsumo: tier !== undefined,
    ...(tier === undefined ? {} : { appsumo_tier: Number(tier) }),
  };
}
