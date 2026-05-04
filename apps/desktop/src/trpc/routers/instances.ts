import { v4 as uuid } from "uuid";
import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import {
  PROVIDER_TYPES,
  PROVIDER_TYPE_MULTI_INSTANCE,
  SINGLETON_INSTANCE_IDS,
  isProviderType,
  type ProviderType,
} from "../../constants/provider-types";
import {
  createInstance,
  deleteInstance,
  getAllInstances,
  getInstanceById,
  getInstancesByProvider,
  updateInstance,
} from "../../db/instances";
import type { InstanceConfig } from "../../db/schema";
import {
  getCatalog,
  invalidateModelsDevCache,
  type CatalogEntry,
} from "../../services/catalog";
import {
  validateInstanceConfig,
  type ValidationResult,
} from "../../services/instance-validators";

// ---------- Zod schemas ----------

const ProviderSchema = z
  .string()
  .refine(isProviderType, { message: "Unknown provider" })
  .transform((value) => value as ProviderType);

// Per-provider config schemas. These are the source of truth for what the
// tRPC layer accepts; the underlying TypeScript types live in db/schema.ts.
const ApiKeyConfigSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
});
const OllamaConfigSchema = z.object({
  url: z.string().url("Must be a valid URL"),
});
const OpenAICompatibleConfigSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
  baseURL: z.string().url("Must be a valid URL"),
});
const EmptyConfigSchema = z.object({}).strict();

// `LocalWhisperDownloadedModel` entries are written by the download
// manager, not the user. The schema is tight even on this path so that
// a malformed update can't slip a path-traversal `filename` past us:
// the runtime resolves `path.join(modelsDirectory, filename)` and we
// never want a `..` separator there.
const LocalWhisperDownloadedModelSchema = z.object({
  id: z.string().min(1),
  filename: z
    .string()
    .min(1)
    .regex(
      /^[A-Za-z0-9._-]+\.bin$/,
      "filename must match the AVAILABLE_MODELS manifest pattern (no path separators)",
    ),
  sizeBytes: z.number().int().nonnegative(),
  checksum: z.string().optional(),
  downloadedAt: z.string(),
});
const LocalWhisperConfigSchema = z.object({
  downloadedModels: z.array(LocalWhisperDownloadedModelSchema).default([]),
});

/**
 * Discriminated config validation keyed on the row's provider. Returns the
 * narrowed config or throws a Zod error the tRPC layer surfaces to the UI.
 */
function parseConfigForProvider(
  provider: ProviderType,
  raw: unknown,
): InstanceConfig {
  switch (provider) {
    case PROVIDER_TYPES.openai:
    case PROVIDER_TYPES.anthropic:
    case PROVIDER_TYPES.groq:
    case PROVIDER_TYPES.openRouter:
      return ApiKeyConfigSchema.parse(raw);
    case PROVIDER_TYPES.ollama:
      return OllamaConfigSchema.parse(raw);
    case PROVIDER_TYPES.openAICompatible:
      return OpenAICompatibleConfigSchema.parse(raw);
    case PROVIDER_TYPES.localWhisper:
      // Bootstrap seeds local-whisper with `{downloadedModels: []}`. The user
      // never edits this via the instance UI; the download manager owns it.
      // The strict per-entry schema above prevents path-traversal filenames
      // even if a hostile renderer reaches this branch.
      return LocalWhisperConfigSchema.parse(raw);
    case PROVIDER_TYPES.mock:
      // `Record<string, never>` is structurally `{}`; the cast bridges Zod's
      // inferred `{}` to TS's stricter "no extra keys" alias.
      return EmptyConfigSchema.parse(raw) as InstanceConfig;
    case PROVIDER_TYPES.googleGemini:
    case PROVIDER_TYPES.vercelAIGateway:
    case PROVIDER_TYPES.cloudflareWorkersAI:
    case PROVIDER_TYPES.cerebras:
      // Coming-soon placeholders — the tile is disabled in the UI so
      // create/update can never legitimately reach here. Reject loudly
      // so a programmatic caller doesn't silently persist a row we
      // can't act on.
      throw new Error(
        `${provider} isn't supported yet — provider listed as "Coming soon"`,
      );
  }
}

const ModelSelectionSchema = z.object({
  instanceId: z.string().min(1),
  modelId: z.string().min(1),
});

const DefaultUseCaseSchema = z.enum([
  "transcription",
  "formatting",
  "embedding",
]);

// ---------- Router ----------

export const instancesRouter = createRouter({
  /** All instance rows, in no particular order. */
  list: procedure.query(async () => {
    return await getAllInstances();
  }),

  listByProvider: procedure
    .input(z.object({ provider: ProviderSchema }))
    .query(async ({ input }) => {
      return await getInstancesByProvider(input.provider);
    }),

  get: procedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      return await getInstanceById(input.id);
    }),

  /**
   * Validate a config without persisting. UI calls this on form submit
   * before invoking `create`/`update` so the user sees credential errors
   * before the row lands in the DB.
   */
  validate: procedure
    .input(z.object({ provider: ProviderSchema, config: z.unknown() }))
    .mutation(async ({ input }): Promise<ValidationResult> => {
      let parsed: InstanceConfig;
      try {
        parsed = parseConfigForProvider(input.provider, input.config);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Invalid config",
        };
      }
      return await validateInstanceConfig(input.provider, parsed);
    }),

  /**
   * Create a new instance. Singleton providers (local-whisper, mock) reject
   * user creation — those are seeded by bootstrap with fixed ids.
   */
  create: procedure
    .input(
      z.object({
        provider: ProviderSchema,
        label: z.string().min(1, "Label is required"),
        config: z.unknown(),
      }),
    )
    .mutation(async ({ input }) => {
      if (!PROVIDER_TYPE_MULTI_INSTANCE[input.provider]) {
        throw new Error(
          `${input.provider} is a singleton provider and is seeded automatically — you can't add another instance`,
        );
      }
      const config = parseConfigForProvider(input.provider, input.config);
      return await createInstance({
        id: uuid(),
        provider: input.provider,
        label: input.label.trim(),
        config,
      });
    }),

  /**
   * Update an instance's label and/or config. Provider is immutable.
   * Caller should re-validate via `validate` before calling this if the
   * config changed.
   *
   * Singleton instances (system-local-whisper, system-mock) are not
   * updatable via this path. Their label is fixed and their config is
   * owned by the download manager / dev tooling — exposing that surface
   * via the user-facing instance editor would let a hostile renderer
   * inject filenames into the local-whisper hot path.
   */
  update: procedure
    .input(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1).optional(),
        config: z.unknown().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (isSingletonId(input.id)) {
        throw new Error(
          `${input.id} is a system instance and can't be updated via this path`,
        );
      }

      const existing = await getInstanceById(input.id);
      if (!existing) {
        throw new Error(`Instance not found: ${input.id}`);
      }
      if (!isProviderType(existing.provider)) {
        throw new Error(
          `Instance ${input.id} has unknown provider "${existing.provider}"`,
        );
      }

      const patch: { label?: string; config?: InstanceConfig } = {};
      if (input.label !== undefined) patch.label = input.label.trim();
      if (input.config !== undefined) {
        patch.config = parseConfigForProvider(existing.provider, input.config);
      }
      return await updateInstance(input.id, patch);
    }),

  /**
   * Delete an instance and clear any modelDefaults selections that pointed
   * at it. Singletons can't be removed via this path.
   */
  remove: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      // Refuse to remove singletons. Their PKs are well-known and removing
      // them would leave the runtime in a confused state.
      if (isSingletonId(input.id)) {
        throw new Error(
          `${input.id} is a system instance and can't be removed`,
        );
      }

      const settingsService = ctx.serviceManager.getService("settingsService");
      if (!settingsService) {
        throw new Error("Settings service unavailable");
      }

      const removed = await deleteInstance(input.id);
      // Clear any defaults that pointed at this id so the picker doesn't
      // surface a stale "(deleted)" entry.
      await settingsService.clearDefaultsForInstance(input.id);
      return removed;
    }),

  /**
   * Fetch the model catalog for a single instance. The picker mounts this
   * on demand; React Query caches it for the session, with an explicit
   * refresh button calling `refreshCatalogs` to bust the main-process
   * models.dev memo before the React Query cache is invalidated.
   */
  fetchCatalog: procedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }): Promise<CatalogEntry[]> => {
      const instance = await getInstanceById(input.id);
      if (!instance) {
        throw new Error(`Instance not found: ${input.id}`);
      }
      return await getCatalog(instance);
    }),

  refreshCatalogs: procedure.mutation(async () => {
    invalidateModelsDevCache();
    return { ok: true };
  }),

  // ---------- modelDefaults (per use-case selections) ----------

  getDefaults: procedure.query(async ({ ctx }) => {
    const settingsService = ctx.serviceManager.getService("settingsService");
    if (!settingsService) throw new Error("Settings service unavailable");
    return (await settingsService.getModelDefaults()) ?? {};
  }),

  setDefault: procedure
    .input(
      z.object({
        useCase: DefaultUseCaseSchema,
        selection: ModelSelectionSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const settingsService = ctx.serviceManager.getService("settingsService");
      if (!settingsService) throw new Error("Settings service unavailable");

      // Verify the instance still exists so we don't persist a dangling pointer.
      const instance = await getInstanceById(input.selection.instanceId);
      if (!instance) {
        throw new Error(
          `Instance ${input.selection.instanceId} not found — cannot set as default`,
        );
      }

      if (input.useCase === "transcription") {
        // Two paths converge here:
        //   - Selection on the local-whisper instance: route through
        //     ModelService so its in-memory state, selection-changed
        //     event, and the SettingsService write all happen together.
        //     Required path — throw if ModelService is somehow absent
        //     rather than silently falling through to the direct write
        //     (which would leave ModelService's cache stale).
        //   - Selection on any other instance (e.g. Groq Whisper): write
        //     the default directly. ModelService doesn't manage non-local
        //     transcription, but TranscriptionService still needs the
        //     speech-changed signal so any preloaded local model can be
        //     released.
        if (
          instance.id === SINGLETON_INSTANCE_IDS[PROVIDER_TYPES.localWhisper]
        ) {
          const modelService = ctx.serviceManager.getService("modelService");
          if (!modelService) throw new Error("Model service unavailable");
          await modelService.setSelectedModel(input.selection.modelId);
          await notifyTranscriptionModelChange(ctx);
          return true;
        }

        await settingsService.setDefault(input.useCase, input.selection);
        await notifyTranscriptionModelChange(ctx);
        return true;
      }

      await settingsService.setDefault(input.useCase, input.selection);
      return true;
    }),

  clearDefault: procedure
    .input(z.object({ useCase: DefaultUseCaseSchema }))
    .mutation(async ({ input, ctx }) => {
      const settingsService = ctx.serviceManager.getService("settingsService");
      if (!settingsService) throw new Error("Settings service unavailable");

      if (input.useCase === "transcription") {
        // Decide routing based on the *current* default's instance, not
        // by guessing — ModelService.setSelectedModel(null) silently
        // no-ops when its `getSelectedModel()` returns null (which it
        // does for non-local-whisper defaults).
        const current = (await settingsService.getModelDefaults())
          ?.transcription;
        const isLocalWhisperCurrent =
          current?.instanceId ===
          SINGLETON_INSTANCE_IDS[PROVIDER_TYPES.localWhisper];

        if (isLocalWhisperCurrent) {
          const modelService = ctx.serviceManager.getService("modelService");
          if (!modelService) throw new Error("Model service unavailable");
          await modelService.setSelectedModel(null);
          await notifyTranscriptionModelChange(ctx);
          return true;
        }

        await settingsService.clearDefault(input.useCase);
        await notifyTranscriptionModelChange(ctx);
        return true;
      }

      await settingsService.clearDefault(input.useCase);
      return true;
    }),
});

function isSingletonId(id: string): boolean {
  return Object.values(SINGLETON_INSTANCE_IDS).includes(id);
}

async function notifyTranscriptionModelChange(ctx: {
  serviceManager: {
    getService: (name: "transcriptionService") => unknown;
    getLogger: () => { main: { error: (msg: string, err: unknown) => void } };
  };
}): Promise<void> {
  const transcriptionService = ctx.serviceManager.getService(
    "transcriptionService",
  ) as { handleModelChange: () => Promise<void> } | undefined;
  if (!transcriptionService) return;
  try {
    await transcriptionService.handleModelChange();
  } catch (error) {
    ctx.serviceManager
      .getLogger()
      .main.error("Failed to handle model change:", error);
  }
}
