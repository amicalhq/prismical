"use client";
import { useMemo } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PROVIDER_TYPE_MULTI_INSTANCE,
  SINGLETON_INSTANCE_IDS,
  type ProviderType,
} from "@/constants/provider-types";
import { PROVIDER_META } from "@/renderer/main/components/provider-meta";
import type { Instance } from "@/db/schema";
import InstanceRow from "./instance-row";

interface ProviderTypeSectionProps {
  type: ProviderType;
  instances: Instance[];
  onAdd: () => void;
  onEdit: (id: string) => void;
}

export default function ProviderTypeSection({
  type,
  instances,
  onAdd,
  onEdit,
}: ProviderTypeSectionProps) {
  const meta = PROVIDER_META[type];
  const isMulti = PROVIDER_TYPE_MULTI_INSTANCE[type];
  const singletonId = SINGLETON_INSTANCE_IDS[type];

  // For singletons, we don't show an Add button or per-row controls — the
  // row exists once, seeded by bootstrap, and isn't user-editable here.
  const visibleInstances = useMemo(
    () => instances.filter((i) => i.type === type),
    [instances, type],
  );

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <meta.Logo className={`size-4 ${meta.tint ?? ""}`} />
          <span className="text-sm font-medium">{meta.label}</span>
          {visibleInstances.length > 0 && (
            <span className="text-xs text-muted-foreground">
              ({visibleInstances.length})
            </span>
          )}
        </div>
        {isMulti && (
          <Button size="sm" variant="ghost" onClick={onAdd} className="h-7 gap-1">
            <Plus className="size-3.5" />
            Add
          </Button>
        )}
      </div>

      {visibleInstances.length === 0 ? (
        <p className="text-xs text-muted-foreground pl-6">
          {isMulti
            ? "Not connected"
            : singletonId
              ? "System instance"
              : "Unavailable"}
        </p>
      ) : (
        <div className="space-y-1 pl-6">
          {visibleInstances.map((instance) => (
            <InstanceRow
              key={instance.id}
              instance={instance}
              editable={isMulti}
              onEdit={() => onEdit(instance.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
