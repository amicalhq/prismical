import { Context, Data, type Effect } from 'effect';
import type { LanguageModel } from 'ai';
import type { AiModelListing, AiProviderKind } from '@prismical/desktop-contracts';
import type { DbError } from '../../infra/operational-db/service';

export type { AiModelListing, AiProviderKind };

/**
 * What a (provider, model) pair has been observed to do with tool calling —
 * the memo the local skill runner's fallback ladder consults:
 *   unknown     → try the native terminal tool with a forced choice first;
 *   native      → the forced-tool contract works (the production path);
 *   auto-only   → the provider rejects a FORCED tool choice but honours tools
 *                 under 'auto' (e.g. Anthropic's Fable-class models);
 *   none        → tools are unusable — go straight to the structured-output
 *                 (JSON-in-text) fallback.
 */
export type ToolSupport = 'unknown' | 'native' | 'auto-only' | 'none';

export class AiProviderError extends Data.TaggedError('AiProviderError')<{
  readonly reason: 'not-configured' | 'unknown-instance' | 'model-required' | 'disabled';
  readonly provider: AiProviderKind | null;
}> {}

/** The model a local Ask/Skill run executes on, plus what the run needs to know about it. */
export interface ResolvedAiModel {
  readonly provider: AiProviderKind;
  readonly modelId: string;
  /** The synthetic local instance id the renderer addresses this provider by. */
  readonly instanceId: string;
  readonly model: LanguageModel;
  readonly toolSupport: ToolSupport;
}

/** A configured provider as the renderer's model pickers see it (a synthetic `instance` row). */
export interface AiInstanceView {
  readonly instanceId: string;
  readonly provider: AiProviderKind;
  readonly label: string;
  /** The model ids the picker offers: the chosen model first, then the live catalogue. */
  readonly models: ReadonlyArray<string>;
}

export interface AiModelSelection {
  readonly instanceId: string;
  readonly modelId: string;
}

/**
 * The AiProvider is the one place a language
 * model is built for the local Ask/Skills lanes. Reads the `ai` device setting
 * + the per-provider secure-store keys on every resolve (settings edits take
 * effect on the next run, no restart), builds an AI-SDK LanguageModel through
 * the provider's official SDK, and serves the live model catalogue the
 * settings card and the synthetic `/me/instances` rows offer.
 *
 * Boot-scoped: device state shared by both modes (cloud mode gains
 * BYOK/local LLM later without a second seam), and the tool-support memo must
 * survive a workspace rebuild.
 */
export interface AiProviderApi {
  /**
   * Build the model for a run. `selection` is the request's
   * (instanceId, modelId) pair — absent (the renderer's "Auto") resolves the
   * device default provider + model.
   */
  readonly resolve: (selection?: {
    readonly instanceId?: string;
    readonly modelId?: string;
  }) => Effect.Effect<ResolvedAiModel, AiProviderError>;
  /**
   * The provider's live catalogue (cached briefly; `force` bypasses the cache —
   * the settings card's Refresh and a just-saved key). Never fails — an error
   * rides the listing.
   */
  readonly listModels: (provider: AiProviderKind, force?: boolean) => Effect.Effect<AiModelListing>;
  /** Drop everything remembered about a provider (its catalogue + tool memo) — a key or endpoint changed. */
  readonly forget: (provider: AiProviderKind) => Effect.Effect<void>;
  /** Enabled, configured providers as synthetic instance rows (including the active enabled provider). */
  readonly instances: Effect.Effect<ReadonlyArray<AiInstanceView>>;
  /** The device default as a (instanceId, modelId) pair — null when no model can be named yet. */
  readonly defaultSelection: Effect.Effect<AiModelSelection | null>;
  /** Point the device default at a local instance + model; false = unknown or disabled provider. */
  readonly setDefault: (selection: AiModelSelection) => Effect.Effect<boolean, DbError>;
  /** Record what a run learned about a (provider, model)'s tool calling. */
  readonly rememberToolSupport: (
    provider: AiProviderKind,
    modelId: string,
    support: ToolSupport
  ) => Effect.Effect<void>;
}

export class AiProvider extends Context.Tag('desktop/ai-provider/AiProvider')<
  AiProvider,
  AiProviderApi
>() {}
