"use client";
import { useState } from "react";
import { Mic, MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type ProviderType } from "@/constants/provider-types";

import DefaultCard from "./components/default-card";
import ChangeDefaultDialog from "./components/change-default-dialog";
import ConnectedList from "./components/connected-list";
import AvailableTiles from "./components/available-tiles";
import WhisperManageDialog from "./components/whisper-manage-dialog";
import InstanceFormDialog from "./components/instance-form-dialog";

type ChangeTarget = "transcription" | "formatting" | null;
type FormMode =
  | { kind: "create"; type: ProviderType }
  | { kind: "edit"; id: string }
  | null;

export default function AIModelsSettingsPage() {
  const { t } = useTranslation();

  // The page owns each dialog's open state so children can trigger
  // them via callback (avoids prop-drilling open/close all the way
  // down).
  const [changeTarget, setChangeTarget] = useState<ChangeTarget>(null);
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [whisperOpen, setWhisperOpen] = useState(false);

  const openWhisperManager = () => setWhisperOpen(true);

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">{t("settings.aiModels.title")}</h1>

      <section className="mb-6">
        <h2 className="text-sm font-semibold text-muted-foreground mb-2">
          Defaults
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <DefaultCard
            useCase="transcription"
            title="Transcription"
            Icon={Mic}
            onChange={() => setChangeTarget("transcription")}
          />
          <DefaultCard
            useCase="formatting"
            title="Formatting & notes"
            Icon={MessageSquare}
            onChange={() => setChangeTarget("formatting")}
          />
        </div>
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-semibold text-muted-foreground mb-2">
          Connected
        </h2>
        <ConnectedList
          onEdit={(id) => setFormMode({ kind: "edit", id })}
          onOpenWhisperManager={openWhisperManager}
        />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-muted-foreground mb-2">
          Add a provider
        </h2>
        <AvailableTiles
          onAddCloud={(type) => setFormMode({ kind: "create", type })}
          onOpenWhisperManager={openWhisperManager}
        />
      </section>

      {changeTarget && (
        <ChangeDefaultDialog
          open={!!changeTarget}
          onOpenChange={(open) => {
            if (!open) setChangeTarget(null);
          }}
          useCase={changeTarget}
          onOpenWhisperManager={openWhisperManager}
        />
      )}

      <InstanceFormDialog
        open={!!formMode}
        onOpenChange={(open) => {
          if (!open) setFormMode(null);
        }}
        mode={formMode}
      />

      <WhisperManageDialog
        open={whisperOpen}
        onOpenChange={setWhisperOpen}
      />
    </div>
  );
}
