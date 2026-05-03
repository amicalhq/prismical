"use client";
import { Card, CardContent } from "@/components/ui/card";
import DefaultModelPicker from "../components/default-model-picker";

export default function LanguageTab() {
  return (
    <Card>
      <CardContent className="space-y-6 p-6">
        <DefaultModelPicker
          useCase="formatting"
          title="Default formatting model"
        />
        <p className="text-xs text-muted-foreground">
          Used for formatting transcriptions and generating notes from
          recordings. Add or manage providers in the Providers section above.
        </p>
      </CardContent>
    </Card>
  );
}
