"use client";

import { useState } from "react";
import { Bot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { api } from "@/trpc/react";

const DISMISSED_KEY = "prismical:llm-setup-prompt-dismissed";

export function LLMSetupPromptToast() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const onboardingState = api.onboarding.getState.useQuery();
  const defaultLanguageModel = api.models.getDefaultLanguageModel.useQuery();

  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  });

  const isOnboardingComplete = !!onboardingState.data?.completedVersion;
  const hasLLM = !!defaultLanguageModel.data;

  if (!isOnboardingComplete || hasLLM || dismissed) return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  };

  const handleSetup = () => {
    dismiss();
    void navigate({ to: "/settings/ai-models", search: { tab: "language" } });
  };

  const handleSkip = () => {
    dismiss();
  };

  return (
    <div className="max-w-sm rounded-lg border bg-card p-4 shadow-lg">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-primary/10 p-2">
          <Bot className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-sm font-medium">
              {t("onboarding.llmPrompt.title")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("onboarding.llmPrompt.description")}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={handleSkip}>
              {t("onboarding.llmPrompt.skip")}
            </Button>
            <Button size="sm" onClick={handleSetup}>
              {t("onboarding.llmPrompt.setup")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
