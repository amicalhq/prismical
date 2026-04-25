import Lottie from "lottie-react";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import successAnimation from "./success-animation.json";

interface CompletionScreenProps {
  onComplete: () => void;
}

export function CompletionScreen({ onComplete }: CompletionScreenProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-8">
      <div className="flex max-w-xl flex-col items-center gap-6 text-center">
        <div className="h-48 w-48">
          <Lottie animationData={successAnimation} loop={false} autoplay />
        </div>

        <div className="space-y-3">
          <h1 className="text-4xl font-bold tracking-tight">
            {t("onboarding.completion.title")}
          </h1>
          <p className="text-lg text-muted-foreground">
            {t("onboarding.completion.subtitle")}
          </p>
        </div>

        <div className="pt-2">
          <Button size="lg" onClick={onComplete} className="gap-2">
            {t("onboarding.completion.start")}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
