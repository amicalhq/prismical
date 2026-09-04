/**
 * The promise-shaped view of AiProvider that the async route handlers use.
 * The router is plain async code over SQLite (like the other local
 * lanes); this adapter runs the Effect API on the workspace runtime so the
 * handlers never touch Effect.
 */
import { Effect, Either, type Runtime } from 'effect';
import type { AiModelListing, AiProviderKind } from '@prismical/desktop-contracts';
import type {
  AiInstanceView,
  AiModelSelection,
  AiProviderApi,
  AiProviderError,
  ResolvedAiModel,
  ToolSupport,
} from '../ai-provider/service';

export type ResolveResult =
  | { readonly ok: true; readonly value: ResolvedAiModel }
  | { readonly ok: false; readonly error: AiProviderError };

export interface LocalAiPort {
  readonly resolve: (selection?: {
    readonly instanceId?: string;
    readonly modelId?: string;
  }) => Promise<ResolveResult>;
  readonly instances: () => Promise<ReadonlyArray<AiInstanceView>>;
  readonly listModels: (provider: AiProviderKind) => Promise<AiModelListing>;
  readonly defaultSelection: () => Promise<AiModelSelection | null>;
  readonly setDefault: (selection: AiModelSelection) => Promise<boolean>;
  readonly rememberToolSupport: (
    provider: AiProviderKind,
    modelId: string,
    support: ToolSupport
  ) => Promise<void>;
}

export const makeLocalAiPort = (api: AiProviderApi, runtime: Runtime.Runtime<never>): LocalAiPort => {
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, runtime.context));
  return {
    resolve: selection =>
      run(Effect.either(api.resolve(selection))).then(either =>
        Either.isRight(either)
          ? { ok: true, value: either.right }
          : { ok: false, error: either.left }
      ),
    instances: () => run(api.instances),
    listModels: provider => run(api.listModels(provider)),
    defaultSelection: () => run(api.defaultSelection),
    setDefault: selection => run(api.setDefault(selection).pipe(Effect.orElseSucceed(() => false))),
    rememberToolSupport: (provider, modelId, support) =>
      run(api.rememberToolSupport(provider, modelId, support)),
  };
};
