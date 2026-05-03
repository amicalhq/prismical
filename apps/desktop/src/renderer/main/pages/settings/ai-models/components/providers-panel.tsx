"use client";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/trpc/react";
import { PROVIDER_TYPES, type ProviderType } from "@/constants/provider-types";
import ProviderTypeSection from "./provider-type-section";
import InstanceFormDialog from "./instance-form-dialog";

const isDev = process.env.NODE_ENV !== "production";

// User-visible provider types in display order. Mock is dev-only.
const VISIBLE_TYPES: ProviderType[] = [
  PROVIDER_TYPES.openai,
  PROVIDER_TYPES.anthropic,
  PROVIDER_TYPES.groq,
  PROVIDER_TYPES.openRouter,
  PROVIDER_TYPES.ollama,
  PROVIDER_TYPES.openAICompatible,
  PROVIDER_TYPES.localWhisper,
];

type DialogMode =
  | { kind: "create"; type: ProviderType }
  | { kind: "edit"; id: string };

export default function ProvidersPanel() {
  const instancesQuery = api.instances.list.useQuery();
  const [dialogMode, setDialogMode] = useState<DialogMode | null>(null);

  const types = isDev ? [...VISIBLE_TYPES, PROVIDER_TYPES.mock] : VISIBLE_TYPES;
  const instances = instancesQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Providers</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {types.map((type) => (
          <ProviderTypeSection
            key={type}
            type={type}
            instances={instances}
            onAdd={() => setDialogMode({ kind: "create", type })}
            onEdit={(id) => setDialogMode({ kind: "edit", id })}
          />
        ))}
      </CardContent>

      <InstanceFormDialog
        open={dialogMode !== null}
        onOpenChange={(open) => {
          if (!open) setDialogMode(null);
        }}
        mode={dialogMode}
      />
    </Card>
  );
}
