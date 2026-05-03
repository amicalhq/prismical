"use client";
import { Card, CardContent } from "@/components/ui/card";
import DefaultModelPicker from "../components/default-model-picker";

export default function EmbeddingTab() {
  return (
    <Card>
      <CardContent className="space-y-6 p-6">
        <DefaultModelPicker
          useCase="embedding"
          title="Default embedding model"
        />
        <p className="text-xs text-muted-foreground">
          Reserved for upcoming retrieval features. You can pick a default
          today; nothing uses it yet.
        </p>
      </CardContent>
    </Card>
  );
}
