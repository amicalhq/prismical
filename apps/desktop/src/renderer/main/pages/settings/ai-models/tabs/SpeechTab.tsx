"use client";
import { ComponentProps, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Download,
  Zap,
  Circle,
  Square,
  Loader2,
  Trash2,
} from "lucide-react";
import { DynamicIcon } from "lucide-react/dynamic";
import {
  TooltipContent,
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { DownloadProgress } from "@/constants/models";
import { api } from "@/trpc/react";
import DefaultModelPicker from "../components/default-model-picker";

const SpeedRating = ({ rating }: { rating: number }) => {
  const fullIcons = Math.floor(rating);
  const hasHalf = rating % 1 !== 0;
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: 5 }, (_, i) => {
        if (i < fullIcons) {
          return (
            <Zap key={i} className="w-4 h-4 fill-yellow-400 text-yellow-400" />
          );
        } else if (i === fullIcons && hasHalf) {
          return (
            <div key={i} className="relative w-4 h-4">
              <Zap className="w-4 h-4 text-gray-300" />
              <div className="absolute inset-0 overflow-hidden w-1/2">
                <Zap className="w-4 h-4 fill-yellow-400 text-yellow-400" />
              </div>
            </div>
          );
        } else {
          return <Zap key={i} className="w-4 h-4 text-gray-300" />;
        }
      })}
      <span className="text-sm text-muted-foreground ml-1">{rating}</span>
    </div>
  );
};

const AccuracyRating = ({ rating }: { rating: number }) => {
  const fullIcons = Math.floor(rating);
  const hasHalf = rating % 1 !== 0;
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: 5 }, (_, i) => {
        if (i < fullIcons) {
          return (
            <Circle key={i} className="w-4 h-4 fill-green-500 text-green-500" />
          );
        } else if (i === fullIcons && hasHalf) {
          return (
            <div key={i} className="relative w-4 h-4">
              <Circle className="w-4 h-4 text-gray-300" />
              <div className="absolute inset-0 overflow-hidden w-1/2">
                <Circle className="w-4 h-4 fill-green-500 text-green-500" />
              </div>
            </div>
          );
        } else {
          return <Circle key={i} className="w-4 h-4 text-gray-300" />;
        }
      })}
      <span className="text-sm text-muted-foreground ml-1">{rating}</span>
    </div>
  );
};

export default function SpeechTab() {
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, DownloadProgress>
  >({});
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [modelToDelete, setModelToDelete] = useState<string | null>(null);

  const availableModelsQuery = api.models.getAvailableModels.useQuery();
  const downloadedModelsQuery = api.models.getDownloadedModels.useQuery();
  const activeDownloadsQuery = api.models.getActiveDownloads.useQuery();
  const isTranscriptionAvailableQuery =
    api.models.isTranscriptionAvailable.useQuery();
  const selectedModelQuery = api.models.getSelectedModel.useQuery();

  const utils = api.useUtils();

  const downloadModelMutation = api.models.downloadModel.useMutation({
    onSuccess: () => {
      utils.models.getDownloadedModels.invalidate();
      utils.models.getActiveDownloads.invalidate();
    },
    onError: () => toast.error("Failed to start download"),
  });

  const cancelDownloadMutation = api.models.cancelDownload.useMutation({
    onSuccess: () => utils.models.getActiveDownloads.invalidate(),
    onError: () => toast.error("Failed to cancel download"),
  });

  const deleteModelMutation = api.models.deleteModel.useMutation({
    onSuccess: () => {
      utils.models.getDownloadedModels.invalidate();
      setShowDeleteDialog(false);
      setModelToDelete(null);
    },
    onError: () => {
      toast.error("Failed to delete model");
      setShowDeleteDialog(false);
      setModelToDelete(null);
    },
  });

  const setSelectedModelMutation = api.models.setSelectedModel.useMutation({
    onSuccess: () => {
      utils.models.getSelectedModel.invalidate();
      utils.instances.getDefaults.invalidate();
    },
    onError: () => toast.error("Failed to select model"),
  });

  // Initialize active downloads progress on load
  useEffect(() => {
    if (activeDownloadsQuery.data) {
      const progressMap: Record<string, DownloadProgress> = {};
      activeDownloadsQuery.data.forEach((download) => {
        progressMap[download.modelId] = download;
      });
      setDownloadProgress(progressMap);
    }
  }, [activeDownloadsQuery.data]);

  api.models.onDownloadProgress.useSubscription(undefined, {
    onData: ({ modelId, progress }) => {
      setDownloadProgress((prev) => ({ ...prev, [modelId]: progress }));
    },
  });

  api.models.onDownloadComplete.useSubscription(undefined, {
    onData: ({ modelId }) => {
      setDownloadProgress((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
      utils.models.getDownloadedModels.invalidate();
      utils.models.getActiveDownloads.invalidate();
      utils.models.getSelectedModel.invalidate();
      utils.instances.fetchCatalog.invalidate();
    },
  });

  api.models.onDownloadError.useSubscription(undefined, {
    onData: ({ modelId, error }) => {
      setDownloadProgress((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
      toast.error(`Download failed: ${error}`);
      utils.models.getActiveDownloads.invalidate();
    },
  });

  api.models.onDownloadCancelled.useSubscription(undefined, {
    onData: ({ modelId }) => {
      setDownloadProgress((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
      utils.models.getActiveDownloads.invalidate();
    },
  });

  api.models.onModelDeleted.useSubscription(undefined, {
    onData: () => {
      utils.models.getDownloadedModels.invalidate();
      utils.instances.fetchCatalog.invalidate();
    },
  });

  const handleDownload = (modelId: string, event?: React.MouseEvent) => {
    event?.preventDefault();
    event?.stopPropagation();
    downloadModelMutation.mutate({ modelId });
  };

  const handleCancelDownload = (modelId: string, event?: React.MouseEvent) => {
    event?.preventDefault();
    event?.stopPropagation();
    cancelDownloadMutation.mutate({ modelId });
  };

  const handleDeleteClick = (modelId: string, event?: React.MouseEvent) => {
    event?.preventDefault();
    event?.stopPropagation();
    setModelToDelete(modelId);
    setShowDeleteDialog(true);
  };

  const handleDeleteConfirm = () => {
    if (modelToDelete) {
      deleteModelMutation.mutate({ modelId: modelToDelete });
    }
  };

  const handleSelectModel = (modelId: string) => {
    setSelectedModelMutation.mutate({ modelId });
  };

  const loading =
    availableModelsQuery.isLoading ||
    downloadedModelsQuery.isLoading ||
    isTranscriptionAvailableQuery.isLoading ||
    selectedModelQuery.isLoading;

  const availableModels = availableModelsQuery.data || [];
  const downloadedModels = downloadedModelsQuery.data || {};
  const isTranscriptionAvailable = isTranscriptionAvailableQuery.data || false;
  const selectedModel = selectedModelQuery.data;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin" />
        <span className="ml-2">Loading…</span>
      </div>
    );
  }

  return (
    <>
      <Card>
        <CardContent className="space-y-6 p-6">
          <DefaultModelPicker
            useCase="transcription"
            title="Default transcription model"
          />

          <div>
            <Label className="text-base font-semibold mb-2 block">
              Local Whisper downloads
            </Label>
            <p className="text-xs text-muted-foreground mb-3">
              Download a Whisper model to transcribe locally on this machine.
              The selected model below also becomes the default transcription
              model when no other provider is chosen above.
            </p>
            <div className="divide-y border rounded-md bg-muted/30">
              <TooltipProvider>
                <RadioGroup
                  value={selectedModel || ""}
                  onValueChange={handleSelectModel}
                >
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Model</TableHead>
                        <TableHead>Features</TableHead>
                        <TableHead>Speed</TableHead>
                        <TableHead>Accuracy</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {availableModels.map((model) => {
                        const isDownloaded = !!downloadedModels[model.id];
                        const progress = downloadProgress[model.id];
                        const isDownloading =
                          progress?.status === "downloading";
                        const canSelect =
                          isDownloaded && isTranscriptionAvailable;

                        return (
                          <TableRow
                            key={model.id}
                            className={`hover:bg-muted/50 ${canSelect ? "cursor-pointer" : ""}`}
                            onClick={() =>
                              canSelect && handleSelectModel(model.id)
                            }
                          >
                            <TableCell>
                              <div className="flex items-center space-x-3">
                                <RadioGroupItem
                                  value={model.id}
                                  id={model.id}
                                  disabled={!canSelect}
                                />
                                <Label
                                  htmlFor={model.id}
                                  className="font-semibold cursor-pointer"
                                >
                                  {model.name}
                                </Label>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-2">
                                {model.features.map((feature, i) => (
                                  <Tooltip key={i}>
                                    <TooltipTrigger asChild>
                                      <div className="p-2 rounded-md bg-muted hover:bg-muted/80 cursor-help transition-colors">
                                        <DynamicIcon
                                          name={
                                            feature.icon as ComponentProps<
                                              typeof DynamicIcon
                                            >["name"]
                                          }
                                          className="w-4 h-4"
                                        />
                                      </div>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>{feature.tooltip}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                ))}
                              </div>
                            </TableCell>
                            <TableCell>
                              <SpeedRating rating={model.speed} />
                            </TableCell>
                            <TableCell>
                              <AccuracyRating rating={model.accuracy} />
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col items-center space-y-1">
                                {!isDownloaded && !isDownloading && (
                                  <button
                                    onClick={(e) =>
                                      handleDownload(model.id, e)
                                    }
                                    className="w-8 h-8 rounded-full bg-muted hover:bg-muted/80 flex items-center justify-center text-primary-foreground transition-colors"
                                    title="Download"
                                  >
                                    <Download className="w-4 h-4 text-muted-foreground" />
                                  </button>
                                )}

                                {!isDownloaded && isDownloading && (
                                  <div className="relative">
                                    <button
                                      type="button"
                                      onClick={(e) =>
                                        handleCancelDownload(model.id, e)
                                      }
                                      className="w-8 h-8 rounded-full bg-orange-500 hover:bg-orange-600 flex items-center justify-center text-white transition-colors"
                                      title="Cancel download"
                                      aria-label={`Cancel download of ${model.name}`}
                                    >
                                      <Square className="w-4 h-4" />
                                    </button>

                                    {progress && (
                                      <svg
                                        className="absolute inset-0 w-8 h-8 -rotate-90 pointer-events-none"
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
                                          strokeDasharray={`${Math.max(0, Math.min(100, progress.progress))} 100`}
                                          strokeLinecap="round"
                                          className="text-white transition-all duration-300"
                                        />
                                      </svg>
                                    )}
                                  </div>
                                )}

                                {isDownloaded && (
                                  <button
                                    type="button"
                                    onClick={(e) =>
                                      handleDeleteClick(model.id, e)
                                    }
                                    className="w-8 h-8 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white transition-colors"
                                    title="Delete"
                                    aria-label={`Delete ${model.name}`}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                )}

                                <div className="text-xs text-muted-foreground text-center">
                                  {model.sizeFormatted}
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </RadioGroup>
              </TooltipProvider>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this model?</AlertDialogTitle>
            <AlertDialogDescription>
              The .bin file will be removed from disk. You can re-download it
              any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-red-500 hover:bg-red-600"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
