"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

import {
  type Instance,
  type InstanceConfig,
  type ModelDefaults,
  type ModelSelection,
  type UseCase,
} from "../../mock-data";
import type { ProviderType } from "../../../../lib/providers";
import { AUTO_SELECTION, PRISMICAL_CLOUD_INSTANCE_ID } from "@prismical/app-client";
import {
  useCreateInstance,
  useDeleteInstance,
  useInstances,
  useUpdateInstance,
} from "@prismical/app-client";
import {
  useClearModelDefault,
  useModelDefaults,
  useSetModelDefault,
  type CoreModelDefault,
} from "@prismical/app-client";

// Live-data store for the desktop's tRPC `instances` / `models` routers.
//
// Provider *instances* are the server's `/me/instances` CRUD entity; per-use-case *defaults* are
// now cloud-backed too via `/me/model-defaults` — user scope. Local Whisper model
// management uses the real downloader in the desktop model-manager port.

/** A server selection (instanceId/modelId null ⇒ Auto) → the web's ModelSelection. No row or
 * explicit-Auto both resolve to the managed Auto sentinel; a real instance is a BYOK pick. */
function toSelection(d: CoreModelDefault | null | undefined): ModelSelection {
  return d && d.instanceId && d.modelId
    ? { instanceId: d.instanceId, modelId: d.modelId }
    : AUTO_SELECTION;
}

interface AIModelsContextValue {
  instances: Instance[];
  /** True while the first instance-list fetch is in flight. */
  loading: boolean;
  defaults: ModelDefaults;

  getInstance: (id: string) => Instance | undefined;
  setDefault: (useCase: UseCase, selection: ModelSelection) => void;
  createInstance: (
    provider: ProviderType,
    label: string,
    config: InstanceConfig,
    credentials?: Record<string, unknown>,
  ) => Promise<void>;
  updateInstance: (
    id: string,
    label: string,
    config: InstanceConfig,
    credentials?: Record<string, unknown>,
  ) => Promise<void>;
  removeInstance: (id: string) => void;
}

const AIModelsContext = createContext<AIModelsContextValue | null>(null);

export function AIModelsProvider({ children }: { children: ReactNode }) {
  const list = useInstances();
  const createM = useCreateInstance();
  const updateM = useUpdateInstance();
  const deleteM = useDeleteInstance();

  // Per-use-case defaults are cloud-backed (user scope). Both "no row" and "explicit Auto" resolve
  // to the managed Auto sentinel, so a card always shows a valid model (managed Auto until a BYOK
  // default is set) rather than an empty state.
  const defaultsQuery = useModelDefaults();
  const setDefaultM = useSetModelDefault();
  const clearDefaultM = useClearModelDefault();
  const defaults = useMemo<ModelDefaults>(
    () => ({
      formatting: toSelection(defaultsQuery.data?.formatting),
      transcription: toSelection(defaultsQuery.data?.transcription),
    }),
    [defaultsQuery.data],
  );

  const setDefault = useCallback(
    (useCase: UseCase, selection: ModelSelection) => {
      // Picking Auto CLEARS the row (revert to inherit / managed Auto) rather than writing an
      // explicit-Auto row — so a future org default isn't silently pinned. A real instance ⇒ BYOK PUT.
      if (selection.instanceId === PRISMICAL_CLOUD_INSTANCE_ID) {
        clearDefaultM.mutate(useCase);
      } else {
        setDefaultM.mutate({ useCase, instanceId: selection.instanceId, modelId: selection.modelId });
      }
    },
    [setDefaultM, clearDefaultM],
  );

  const createInstance = useCallback<AIModelsContextValue["createInstance"]>(
    async (provider, label, config, credentials) => {
      // Credentials contain secret provider configuration. Include them only when non-empty.
      // mutateAsync so the caller can await and keep the dialog open + spinning
      // until the save settles (and the dialog stays open if it rejects).
      await createM.mutateAsync({ provider, label, config, credentials });
    },
    [createM],
  );

  const updateInstance = useCallback<AIModelsContextValue["updateInstance"]>(
    async (id, label, config, credentials) => {
      // On edit, omit credentials entirely when undefined so core preserves the
      // existing secret rather than overwriting it with nothing.
      await updateM.mutateAsync({ id, patch: { label, config, credentials } });
    },
    [updateM],
  );

  const removeInstance = useCallback(
    (id: string) => {
      // Instances are soft-deleted, so the model_default FK cascade does NOT fire; instead the
      // defaults GET filters dangling pointers server-side (→ Auto). Refetch to pick that up.
      deleteM.mutate(id, { onSuccess: () => defaultsQuery.refetch() });
    },
    [deleteM, defaultsQuery],
  );

  const instances = useMemo(() => list.data ?? [], [list.data]);

  const value = useMemo<AIModelsContextValue>(
    () => ({
      instances,
      loading: list.isLoading,
      defaults,
      getInstance: (id) => instances.find((i) => i.id === id),
      setDefault,
      createInstance,
      updateInstance,
      removeInstance,
    }),
    [instances, list.isLoading, defaults, setDefault, createInstance, updateInstance, removeInstance],
  );

  return (
    <AIModelsContext.Provider value={value}>
      {children}
    </AIModelsContext.Provider>
  );
}

export function useAIModels(): AIModelsContextValue {
  const ctx = useContext(AIModelsContext);
  if (!ctx) {
    throw new Error("useAIModels must be used within an AIModelsProvider");
  }
  return ctx;
}
