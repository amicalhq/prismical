import {
  createProviderRegistry,
  type ProviderRegistryProvider,
} from "ai";

import { db } from "@/db";
import { instances } from "@/db/schema";
import {
  isProviderType,
  type ProviderType,
} from "@/constants/provider-types";
import { providerFactories } from "./provider-config";

// `-` and `_` both appear in nanoid ids and most model ids, so use a
// double-colon as the separator. Changing this is a wire-format-breaking
// change — every call site composes its key via `registryKey()`.
const SEPARATOR = "::" as const;

/**
 * Build a fresh provider registry from the current `instances` table state.
 *
 * Deliberately uncached. The dominant cost is one indexed SQL query;
 * provider factories don't perform I/O at construction. A cache + explicit
 * invalidation introduces a classic stale-read race (mutation lands
 * between a caller's DB read and registry use) that's more complex than
 * the per-call rebuild saves. Profile before adding a cache.
 *
 * Caller contract: treat the returned registry as a per-call value. Do
 * NOT stash it on a service field or cache it across awaits. The "no race"
 * property holds only because each caller binds a `languageModel(...)` to
 * a local variable immediately after `getRegistry()` returns — concurrent
 * instance mutations can't reach in and rebind the model mid-call.
 */
export async function getRegistry(): Promise<ProviderRegistryProvider> {
  const rows = await db.select().from(instances);

  // The type guard is needed because `instances.provider` is `text(...).notNull()`
  // — i.e. plain `string` — not narrowed to `ProviderType`.
  //
  // `Object.fromEntries` drops duplicate keys (last write wins). We rely on
  // the `instances.id` primary key invariant — no two rows share an id —
  // so this is safe. If that invariant ever weakens, the silent overwrite
  // would mask a bug.
  const providers: Record<string, ReturnType<NonNullable<(typeof providerFactories)[ProviderType]>>> =
    Object.fromEntries(
      rows
        .filter((row): row is typeof row & { provider: ProviderType } =>
          isProviderType(row.provider) && row.provider in providerFactories,
        )
        .map((row) => [row.id, providerFactories[row.provider]!(row.config)]),
    );

  return createProviderRegistry(providers, { separator: SEPARATOR });
}

/**
 * Compose the registry id from an (instanceId, modelId) tuple. Centralised
 * so the separator change above doesn't ripple to every call site. Typed
 * as a template literal so it satisfies `registry.languageModel`'s
 * `${key}${separator}${model}` constraint.
 */
export function registryKey(
  instanceId: string,
  modelId: string,
): `${string}::${string}` {
  return `${instanceId}${SEPARATOR}${modelId}`;
}
