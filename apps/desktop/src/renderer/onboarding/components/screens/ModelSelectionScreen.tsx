import React, { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronDown, Sparkles, Zap, Circle, Loader2 } from "lucide-react";
import { OnboardingLayout } from "../shared/OnboardingLayout";
import { NavigationButtons } from "../shared/NavigationButtons";
import { useTranslation } from "react-i18next";
import { api } from "@/trpc/react";
import { toast } from "sonner";

interface ModelSelectionScreenProps {
  onNext: (modelId: string) => void;
  onBack: () => void;
  initialSelection?: string;
}

const RATING_LENGTH = 5;

function Rating({
  rating,
  variant,
}: {
  rating: number;
  variant: "speed" | "accuracy";
}) {
  const filled = Math.floor(rating);
  const Icon = variant === "speed" ? Zap : Circle;
  const filledClass =
    variant === "speed"
      ? "fill-yellow-400 text-yellow-400"
      : "fill-green-500 text-green-500";
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: RATING_LENGTH }, (_, i) => (
        <Icon
          key={i}
          className={`h-3.5 w-3.5 ${i < filled ? filledClass : "text-gray-300"}`}
        />
      ))}
      <span className="ml-1 text-xs text-muted-foreground">{rating}</span>
    </div>
  );
}

export function ModelSelectionScreen({
  onNext,
  onBack,
  initialSelection,
}: ModelSelectionScreenProps) {
  const { t } = useTranslation();

  const availableModels = api.models.getAvailableModels.useQuery();
  const downloadedModels = api.models.getDownloadedModels.useQuery();
  const recommended = api.onboarding.getRecommendedLocalModel.useQuery();
  const downloadMutation = api.models.downloadModel.useMutation();
  const setSelectedModelMutation = api.models.setSelectedModel.useMutation();

  const [selectedId, setSelectedId] = useState<string | undefined>(
    initialSelection,
  );

  useEffect(() => {
    if (!selectedId && recommended.data) {
      setSelectedId(recommended.data);
    }
  }, [recommended.data, selectedId]);

  const isLoading = availableModels.isLoading || recommended.isLoading;
  const recommendedId = recommended.data;
  const recommendedModel = (availableModels.data ?? []).find(
    (m) => m.id === recommendedId,
  );
  const otherModels = (availableModels.data ?? []).filter(
    (m) => m.id !== recommendedId,
  );

  const isAlreadyDownloaded =
    !!selectedId && !!downloadedModels.data?.[selectedId];

  const handleContinue = () => {
    if (!selectedId) {
      toast.error(t("onboarding.modelSelection.toast.selectModel"));
      return;
    }
    if (isAlreadyDownloaded) {
      // Already on disk — just mark it as the active speech model.
      setSelectedModelMutation.mutate({ modelId: selectedId });
    } else {
      // Kick off download in background; auto-selection happens on complete.
      downloadMutation.mutate({ modelId: selectedId });
    }
    onNext(selectedId);
  };

  return (
    <OnboardingLayout
      title={t("onboarding.modelSelection.title")}
      subtitle={t("onboarding.modelSelection.subtitle")}
      footer={
        <NavigationButtons
          onBack={onBack}
          onNext={handleContinue}
          disableNext={!selectedId}
          nextLabel={
            isAlreadyDownloaded
              ? t("onboarding.modelSelection.actions.continue")
              : t("onboarding.modelSelection.actions.downloadAndContinue")
          }
        />
      }
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">
            {t("onboarding.modelSelection.loading")}
          </span>
        </div>
      ) : (
        <RadioGroup
          value={selectedId ?? ""}
          onValueChange={(v) => setSelectedId(v)}
        >
          <div className="space-y-4">
            {recommendedModel && (
              <Card
                className={`cursor-pointer p-4 transition-colors ${
                  selectedId === recommendedModel.id
                    ? "border-primary bg-primary/5"
                    : "hover:border-muted-foreground/50"
                }`}
                onClick={() => setSelectedId(recommendedModel.id)}
              >
                <div className="flex items-start gap-3">
                  <RadioGroupItem
                    value={recommendedModel.id}
                    id={recommendedModel.id}
                    className="mt-1.5"
                  />
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-primary" />
                      <Badge variant="secondary" className="text-xs">
                        {t("onboarding.modelSelection.recommendedForYou")}
                      </Badge>
                      {!!downloadedModels.data?.[recommendedModel.id] && (
                        <Badge variant="outline" className="text-xs">
                          {t("onboarding.modelSelection.alreadyDownloaded")}
                        </Badge>
                      )}
                    </div>
                    <div>
                      <Label
                        htmlFor={recommendedModel.id}
                        className="cursor-pointer text-base font-semibold"
                      >
                        {recommendedModel.name}
                      </Label>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t("onboarding.modelSelection.recommendationReason")}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {t("onboarding.modelSelection.table.size")}:{" "}
                        {recommendedModel.sizeFormatted}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span>
                          {t("onboarding.modelSelection.table.speed")}:
                        </span>
                        <Rating
                          rating={recommendedModel.speed}
                          variant="speed"
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span>
                          {t("onboarding.modelSelection.table.accuracy")}:
                        </span>
                        <Rating
                          rating={recommendedModel.accuracy}
                          variant="accuracy"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {otherModels.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm hover:bg-muted/60">
                  <div className="text-left">
                    <p className="font-medium">
                      {t("onboarding.modelSelection.otherModels")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("onboarding.modelSelection.otherModelsDescription")}
                    </p>
                  </div>
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <div className="rounded-md border bg-muted/30">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>
                            {t("onboarding.modelSelection.table.model")}
                          </TableHead>
                          <TableHead>
                            {t("onboarding.modelSelection.table.size")}
                          </TableHead>
                          <TableHead>
                            {t("onboarding.modelSelection.table.speed")}
                          </TableHead>
                          <TableHead>
                            {t("onboarding.modelSelection.table.accuracy")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {otherModels.map((m) => {
                          const isSelected = selectedId === m.id;
                          const downloaded =
                            !!downloadedModels.data?.[m.id];
                          return (
                            <TableRow
                              key={m.id}
                              className={`cursor-pointer hover:bg-muted/50 ${
                                isSelected ? "bg-primary/5" : ""
                              }`}
                              onClick={() => setSelectedId(m.id)}
                            >
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <RadioGroupItem
                                    value={m.id}
                                    id={`row-${m.id}`}
                                  />
                                  <Label
                                    htmlFor={`row-${m.id}`}
                                    className="cursor-pointer font-medium"
                                  >
                                    {m.name}
                                  </Label>
                                  {downloaded && (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px]"
                                    >
                                      {t(
                                        "onboarding.modelSelection.alreadyDownloaded",
                                      )}
                                    </Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>{m.sizeFormatted}</TableCell>
                              <TableCell>
                                <Rating rating={m.speed} variant="speed" />
                              </TableCell>
                              <TableCell>
                                <Rating
                                  rating={m.accuracy}
                                  variant="accuracy"
                                />
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        </RadioGroup>
      )}
    </OnboardingLayout>
  );
}
