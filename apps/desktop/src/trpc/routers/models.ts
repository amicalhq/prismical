import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import type {
  AvailableWhisperModel,
  DownloadProgress,
} from "../../constants/models";
import type { LocalWhisperDownloadedModel } from "../../db/schema";

// What's left of the old models router after the multi-instance refactor:
// it's now scoped to the local-whisper download manager (download / cancel /
// delete / progress events) plus the local-whisper selection. Everything
// remote (catalogs, defaults for language/embedding, instance CRUD) lives
// on the `instances` router.

export const modelsRouter = createRouter({
  // ---------- Catalog of downloadable Whisper models ----------

  getAvailableModels: procedure.query(
    async ({ ctx }): Promise<AvailableWhisperModel[]> => {
      const modelService = ctx.serviceManager.getService("modelService");
      return modelService?.getAvailableModels() || [];
    },
  ),

  getDownloadedModels: procedure.query(
    async ({ ctx }): Promise<Record<string, LocalWhisperDownloadedModel>> => {
      const modelService = ctx.serviceManager.getService("modelService");
      if (!modelService) {
        throw new Error("Model service not available");
      }
      return await modelService.getDownloadedModels();
    },
  ),

  isModelDownloaded: procedure
    .input(z.object({ modelId: z.string() }))
    .query(async ({ input, ctx }) => {
      const modelService = ctx.serviceManager.getService("modelService");
      return modelService
        ? await modelService.isModelDownloaded(input.modelId)
        : false;
    }),

  getDownloadProgress: procedure
    .input(z.object({ modelId: z.string() }))
    .query(async ({ input, ctx }) => {
      const modelService = ctx.serviceManager.getService("modelService");
      return modelService?.getDownloadProgress(input.modelId) || null;
    }),

  getActiveDownloads: procedure.query(
    async ({ ctx }): Promise<DownloadProgress[]> => {
      const modelService = ctx.serviceManager.getService("modelService");
      return modelService?.getActiveDownloads() || [];
    },
  ),

  getModelsDirectory: procedure.query(async ({ ctx }) => {
    const modelService = ctx.serviceManager.getService("modelService");
    return modelService?.getModelsDirectory() || "";
  }),

  isTranscriptionAvailable: procedure.query(async ({ ctx }) => {
    const modelService = ctx.serviceManager.getService("modelService");
    return modelService ? await modelService.isAvailable() : false;
  }),

  getTranscriptionModels: procedure.query(async ({ ctx }) => {
    const modelService = ctx.serviceManager.getService("modelService");
    return modelService
      ? await modelService.getAvailableModelsForTranscription()
      : [];
  }),

  /** The currently selected local-whisper model id, if any. */
  getSelectedModel: procedure.query(async ({ ctx }) => {
    const modelService = ctx.serviceManager.getService("modelService");
    return modelService ? await modelService.getSelectedModel() : null;
  }),

  // ---------- Mutations ----------

  downloadModel: procedure
    .input(z.object({ modelId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const modelService = ctx.serviceManager.getService("modelService");
      if (!modelService) throw new Error("Model service not initialized");
      return await modelService.downloadModel(input.modelId);
    }),

  cancelDownload: procedure
    .input(z.object({ modelId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const modelService = ctx.serviceManager.getService("modelService");
      if (!modelService) throw new Error("Model service not initialized");
      return modelService.cancelDownload(input.modelId);
    }),

  deleteModel: procedure
    .input(z.object({ modelId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const modelService = ctx.serviceManager.getService("modelService");
      if (!modelService) throw new Error("Model service not initialized");
      return modelService.deleteModel(input.modelId);
    }),

  /**
   * Pick or clear the local-whisper speech model. The instances router's
   * `setDefault` for `transcription` routes through this when the
   * selection's instance is system-local-whisper, so callers usually
   * don't need to call this directly — the picker writes through the
   * instances router for uniformity.
   */
  setSelectedModel: procedure
    .input(z.object({ modelId: z.string().nullable() }))
    .mutation(async ({ input, ctx }) => {
      const modelService = ctx.serviceManager.getService("modelService");
      if (!modelService) throw new Error("Model service not initialized");
      await modelService.setSelectedModel(input.modelId);

      // Notify transcription service so the live pipeline updates.
      const transcriptionService = ctx.serviceManager.getService(
        "transcriptionService",
      );
      if (transcriptionService) {
        await transcriptionService.handleModelChange();
      }

      return true;
    }),

  // ---------- Subscriptions ----------
  // Observables (vs async generators) avoid a Symbol.asyncDispose conflict
  // between Node 20+ and electron-trpc; behaviour is otherwise equivalent.

  // eslint-disable-next-line deprecation/deprecation
  onDownloadProgress: procedure.subscription(({ ctx }) => {
    return observable<{ modelId: string; progress: DownloadProgress }>(
      (emit) => {
        const modelService = ctx.serviceManager.getService("modelService");
        if (!modelService) {
          throw new Error("Model service not initialized");
        }
        const handler = (modelId: string, progress: DownloadProgress) => {
          emit.next({ modelId, progress });
        };
        modelService.on("download-progress", handler);
        return () => modelService.off("download-progress", handler);
      },
    );
  }),

  // eslint-disable-next-line deprecation/deprecation
  onDownloadComplete: procedure.subscription(({ ctx }) => {
    return observable<{
      modelId: string;
      entry: LocalWhisperDownloadedModel;
    }>((emit) => {
      const modelService = ctx.serviceManager.getService("modelService");
      if (!modelService) {
        throw new Error("Model service not initialized");
      }
      const handler = (
        modelId: string,
        entry: LocalWhisperDownloadedModel,
      ) => {
        emit.next({ modelId, entry });
      };
      modelService.on("download-complete", handler);
      return () => modelService.off("download-complete", handler);
    });
  }),

  // eslint-disable-next-line deprecation/deprecation
  onDownloadError: procedure.subscription(({ ctx }) => {
    return observable<{ modelId: string; error: string }>((emit) => {
      const modelService = ctx.serviceManager.getService("modelService");
      if (!modelService) {
        throw new Error("Model service not initialized");
      }
      const handler = (modelId: string, error: Error) => {
        emit.next({ modelId, error: error.message });
      };
      modelService.on("download-error", handler);
      return () => modelService.off("download-error", handler);
    });
  }),

  // eslint-disable-next-line deprecation/deprecation
  onDownloadCancelled: procedure.subscription(({ ctx }) => {
    return observable<{ modelId: string }>((emit) => {
      const modelService = ctx.serviceManager.getService("modelService");
      if (!modelService) {
        throw new Error("Model service not initialized");
      }
      const handler = (modelId: string) => emit.next({ modelId });
      modelService.on("download-cancelled", handler);
      return () => modelService.off("download-cancelled", handler);
    });
  }),

  // eslint-disable-next-line deprecation/deprecation
  onModelDeleted: procedure.subscription(({ ctx }) => {
    return observable<{ modelId: string }>((emit) => {
      const modelService = ctx.serviceManager.getService("modelService");
      if (!modelService) {
        throw new Error("Model service not initialized");
      }
      const handler = (modelId: string) => emit.next({ modelId });
      modelService.on("model-deleted", handler);
      return () => modelService.off("model-deleted", handler);
    });
  }),

  // eslint-disable-next-line deprecation/deprecation
  onSelectionChanged: procedure.subscription(({ ctx }) => {
    return observable<{
      oldModelId: string | null;
      newModelId: string | null;
      reason:
        | "manual"
        | "auto-first-download"
        | "auto-after-deletion"
        | "cleared";
    }>((emit) => {
      const modelService = ctx.serviceManager.getService("modelService");
      if (!modelService) {
        throw new Error("Model service not initialized");
      }
      const handler = (
        oldModelId: string | null,
        newModelId: string | null,
        reason:
          | "manual"
          | "auto-first-download"
          | "auto-after-deletion"
          | "cleared",
      ) => {
        emit.next({ oldModelId, newModelId, reason });
      };
      modelService.on("selection-changed", handler);
      return () => modelService.off("selection-changed", handler);
    });
  }),
});
