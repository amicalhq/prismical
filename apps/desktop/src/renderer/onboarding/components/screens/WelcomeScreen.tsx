import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";

interface WelcomeScreenProps {
  onNext: () => void;
}

export function WelcomeScreen({ onNext }: WelcomeScreenProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-8">
      <div className="flex max-w-xl flex-col items-center gap-8 text-center">
        <div className="relative">
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 rounded-full bg-primary/15 blur-2xl"
          />
          <img
            src="assets/icon.svg"
            alt={t("settings.sidebar.logoAlt")}
            className="h-28 w-28 drop-shadow-sm"
          />
        </div>

        <div className="space-y-3">
          <h1 className="text-5xl font-bold tracking-tight">
            {t("onboarding.welcome.title")}
          </h1>
          <p className="text-2xl font-medium text-muted-foreground">
            {t("onboarding.welcome.subtitle")}
          </p>
        </div>

        <div className="pt-2">
          <Button size="lg" onClick={onNext} className="gap-2">
            {t("onboarding.welcome.continue")}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
