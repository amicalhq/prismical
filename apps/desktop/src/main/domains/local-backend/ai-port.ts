/**
 * The promise-shaped view of AiProvider that the async route handlers use.
 * The router is plain async code over SQLite (like the other local
 * lanes); this adapter runs the Effect API in the workspace scope so the
 * handlers never touch Effect.
 */
import { Effect, Result } from 'effect';
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

export const makeLocalAiPort = (
  api: AiProviderApi,
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
): LocalAiPort => {
  return {
    resolve: selection =>
      run(Effect.result(api.resolve(selection))).then(result =>
        Result.isSuccess(result)
          ? { ok: true, value: result.success }
          : { ok: false, error: result.failure }
      ),
    instances: () => run(api.instances),
    listModels: provider => run(api.listModels(provider)),
    defaultSelection: () => run(api.defaultSelection),
    setDefault: selection => run(api.setDefault(selection).pipe(Effect.catch(() => Effect.succeed(false)))),
    rememberToolSupport: (provider, modelId, support) =>
      run(api.rememberToolSupport(provider, modelId, support)),
  };
};
