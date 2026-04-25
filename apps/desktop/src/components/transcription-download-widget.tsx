"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Square, Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/trpc/react";

type Status = "downloading" | "ready";

interface ActiveItem {
  modelId: string;
  modelName: string;
  status: Status;
  progress: number;
}

export function TranscriptionDownloadWidget() {
  const [items, setItems] = useState<Record<string, ActiveItem>>({});

  const availableModelsQuery = api.models.getAvailableModels.useQuery();
  const activeDownloadsQuery = api.models.getActiveDownloads.useQuery();
  const cancelDownload = api.models.cancelDownload.useMutation();

  const nameById = useMemo(() => {
    const map: Record<string, string> = {};
    (availableModelsQuery.data ?? []).forEach((m) => {
      map[m.id] = m.name;
    });
    return map;
  }, [availableModelsQuery.data]);

  const resolveName = (modelId: string) => nameById[modelId] ?? modelId;

  useEffect(() => {
    if (!activeDownloadsQuery.data) return;
    setItems((prev) => {
      const next = { ...prev };
      activeDownloadsQuery.data.forEach((d) => {
        if (next[d.modelId]?.status === "ready") return;
        next[d.modelId] = {
          modelId: d.modelId,
          modelName: resolveName(d.modelId),
          status: "downloading",
          progress: d.progress,
        };
      });
      return next;
    });
  }, [activeDownloadsQuery.data, nameById]);

  api.models.onDownloadProgress.useSubscription(undefined, {
    onData: ({ modelId, progress }) => {
      setItems((prev) => ({
        ...prev,
        [modelId]: {
          modelId,
          modelName: resolveName(modelId),
          status: "downloading",
          progress: progress.progress,
        },
      }));
    },
  });

  api.models.onDownloadComplete.useSubscription(undefined, {
    onData: ({ modelId }) => {
      setItems((prev) => ({
        ...prev,
        [modelId]: {
          modelId,
          modelName: resolveName(modelId),
          status: "ready",
          progress: 100,
        },
      }));
    },
  });

  api.models.onDownloadCancelled.useSubscription(undefined, {
    onData: ({ modelId }) => {
      setItems((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
    },
  });

  api.models.onDownloadError.useSubscription(undefined, {
    onData: ({ modelId }) => {
      setItems((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
    },
  });

  const list = Object.values(items);
  if (list.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {list.map((item) => (
        <DownloadCard
          key={item.modelId}
          item={item}
          onCancel={() => cancelDownload.mutate({ modelId: item.modelId })}
          onDismiss={() =>
            setItems((prev) => {
              const next = { ...prev };
              delete next[item.modelId];
              return next;
            })
          }
        />
      ))}
    </div>
  );
}

function DownloadCard({
  item,
  onCancel,
  onDismiss,
}: {
  item: ActiveItem;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const isReady = item.status === "ready";

  return (
    <div className="flex min-w-[280px] items-center gap-3 rounded-lg border bg-card px-3 py-2 shadow-md">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {isReady
            ? t("onboarding.downloadWidget.ready", { name: item.modelName })
            : t("onboarding.downloadWidget.downloading", {
                name: item.modelName,
              })}
        </p>
      </div>

      {isReady ? (
        <>
          <div className="rounded-full bg-green-500/10 p-1">
            <Check className="h-4 w-4 text-green-500" />
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted"
            aria-label={t("onboarding.downloadWidget.dismiss")}
          >
            <X className="h-4 w-4" />
          </button>
        </>
      ) : (
        <div className="relative">
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-500 text-white transition-colors hover:bg-orange-600"
            aria-label={t("onboarding.downloadWidget.cancel")}
            title={t("onboarding.downloadWidget.cancel")}
          >
            <Square className="h-4 w-4" />
          </button>
          <svg
            className="pointer-events-none absolute inset-0 h-8 w-8 -rotate-90"
            viewBox="0 0 36 36"
          >
            <circle
              cx="18"
              cy="18"
              r="15.9155"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeDasharray="100 100"
              className="text-muted-foreground/30"
            />
            <circle
              cx="18"
              cy="18"
              r="15.9155"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeDasharray={`${Math.max(0, Math.min(100, item.progress))} 100`}
              strokeLinecap="round"
              className="text-white transition-all duration-300"
            />
          </svg>
        </div>
      )}
    </div>
  );
}
