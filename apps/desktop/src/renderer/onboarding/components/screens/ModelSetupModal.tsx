import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Loader2, Download, AlertCircle, Check } from "lucide-react";
import { api } from "@/trpc/react";
import { ModelType } from "../../../../types/onboarding";
import { useTranslation } from "react-i18next";

interface ModelSetupModalProps {
  isOpen: boolean;
  onClose: (wasCompleted?: boolean) => void;
  modelType: ModelType;
  onContinue: () => void; // Called when setup completes - auto-advances to next step
}

/**
 * Modal for setting up the local speech model download.
 */
export function ModelSetupModal({
  isOpen,
  onClose,
  modelType,
  onContinue,
}: ModelSetupModalProps) {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadInfo, setDownloadInfo] = useState<{
    downloaded: number;
    total: number;
    speed?: number;
  } | null>(null);
  const [modelAlreadyInstalled, setModelAlreadyInstalled] = useState(false);
  const [installedModelName, setInstalledModelName] = useState<string>("");
  const [downloadComplete, setDownloadComplete] = useState(false);

  // Get recommended local model based on hardware
  const { data: recommendedModelId = "whisper-base" } =
    api.onboarding.getRecommendedLocalModel.useQuery(undefined, {
      enabled: modelType === ModelType.Local && isOpen,
    });

  const downloadModelMutation = api.models.downloadModel.useMutation();

  // Check for existing downloaded models
  const { data: downloadedModels } = api.models.getDownloadedModels.useQuery(
    undefined,
    {
      enabled: modelType === ModelType.Local && isOpen,
    },
  );

  // Subscribe to download progress
  api.models.onDownloadProgress.useSubscription(undefined, {
    onData: (data) => {
      if (data.modelId === recommendedModelId) {
        setDownloadProgress(data.progress.progress);
        setDownloadInfo({
          downloaded: data.progress.bytesDownloaded || 0,
          total: data.progress.totalBytes || 0,
          speed: undefined, // Speed not available in the current API
        });

        if (data.progress.progress === 100) {
          setDownloadComplete(true);
        }
      }
    },
    enabled: modelType === ModelType.Local && isOpen,
  });

  // Handle model download
  const startDownload = async () => {
    setIsLoading(true);
    setError(null);

    try {
      await downloadModelMutation.mutateAsync({
        modelId: recommendedModelId,
      });
      // Progress will be handled by subscription
    } catch (err) {
      console.error("Download error:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(
        t("onboarding.modelSetup.local.error.downloadFailed", {
          message: errorMessage,
        }),
      );
      setIsLoading(false);
    }
  };

  // Auto-start download for local models or check if already installed
  useEffect(() => {
    if (isOpen && modelType === ModelType.Local && downloadedModels) {
      // Check if any whisper model is already downloaded
      const whisperModels = Object.values(downloadedModels).filter(
        (model) => model.id && model.id.startsWith("whisper-"),
      );

      if (whisperModels.length > 0) {
        // Model already exists - user must click Done to confirm
        setModelAlreadyInstalled(true);
        setInstalledModelName(whisperModels[0].name || whisperModels[0].id);
      } else if (!isLoading && !downloadProgress) {
        // No existing model, start download
        startDownload();
      }
    }
  }, [isOpen, modelType, downloadedModels]);

  // Format bytes to MB
  const formatBytes = (bytes: number) => {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Render local model setup content
  const renderContent = () => {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {modelAlreadyInstalled || downloadComplete
              ? t("onboarding.modelSetup.local.readyTitle")
              : t("onboarding.modelSetup.local.downloadingTitle")}
          </DialogTitle>
          <DialogDescription>
            {modelAlreadyInstalled || downloadComplete
              ? t("onboarding.modelSetup.local.readyDescription")
              : t("onboarding.modelSetup.local.downloadingDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {modelAlreadyInstalled || downloadComplete ? (
            // Show success state when model is ready
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-full bg-green-500/10 p-3">
                <Check className="h-6 w-6 text-green-500" />
              </div>
              <div className="text-center">
                <p className="font-medium">
                  {modelAlreadyInstalled
                    ? t("onboarding.modelSetup.local.alreadyInstalled")
                    : t("onboarding.modelSetup.local.downloadComplete")}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {t("onboarding.modelSetup.local.using", {
                    model: installedModelName || recommendedModelId,
                  })}
                </p>
              </div>
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
              <Button
                onClick={startDownload}
                size="sm"
                variant="outline"
                className="ml-auto"
              >
                {t("onboarding.modelSetup.actions.retry")}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Download className="h-5 w-5 text-muted-foreground" />
                <div className="flex-1">
                  <Progress value={downloadProgress} className="h-2" />
                </div>
                <span className="text-sm font-medium">{downloadProgress}%</span>
              </div>

              {downloadInfo && (
                <div className="text-center text-sm text-muted-foreground">
                  {formatBytes(downloadInfo.downloaded)} /{" "}
                  {formatBytes(downloadInfo.total)}
                  {downloadInfo.speed && (
                    <span>
                      {" "}
                      • {(downloadInfo.speed / 1024 / 1024).toFixed(1)} MB/s
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter className="space-x-2">
          <Button variant="outline" onClick={() => onClose(false)}>
            {t("onboarding.modelSetup.actions.cancel")}
          </Button>
          <Button
            onClick={onContinue}
            disabled={!modelAlreadyInstalled && !downloadComplete}
          >
            {t("onboarding.navigation.continue")}
          </Button>
        </DialogFooter>
      </>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="sm:max-w-md">{renderContent()}</DialogContent>
    </Dialog>
  );
}
