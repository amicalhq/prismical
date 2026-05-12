import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { IconPlus, IconUpload } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { api } from "@/trpc/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { SkillRow } from "./components/skill-row";
import { DeleteSkillDialog } from "./components/delete-skill-dialog";
import type { Skill } from "@/db/schema";

export function SkillsListPage() {
  const { t } = useTranslation();
  const { data: skills = [], isLoading } = api.skills.list.useQuery({});
  const utils = api.useUtils();

  const setEnabled = api.skills.setEnabled.useMutation({
    onSettled: () => utils.skills.list.invalidate(),
  });

  const importMutation = api.skills.import.useMutation({
    onSuccess: () => {
      void utils.skills.list.invalidate();
      toast.success("Skill imported successfully");
    },
    onError: (error) => {
      toast.error(`Import failed: ${error.message}`);
    },
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const ext = file.name.split(".").pop()?.toLowerCase();
    const format = ext === "md" ? "markdown" : "json";

    const content = await file.text();
    importMutation.mutate({ format, content });

    // Reset input so the same file can be re-imported if needed
    event.target.value = "";
  };

  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);

  // Sort: system skills first (descending), then user-created by createdAt desc.
  const sorted = [...skills].sort((a, b) => {
    if (a.system !== b.system) return a.system ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("skills.page.title")}</h1>
        <div className="flex items-center gap-2">
          {/* Hidden file input for importing skills */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.md"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            variant="outline"
            onClick={handleImportClick}
            disabled={importMutation.isPending}
          >
            <IconUpload size={18} className="mr-1" />
            Import skill
          </Button>
          <Button asChild>
            <Link to="/skills/new">
              <IconPlus size={18} className="mr-1" />
              {t("skills.page.newSkill")}
            </Link>
          </Button>
        </div>
      </header>

      <section className="rounded-lg border bg-card">
        <div className="px-4 py-3 border-b">
          <h2 className="font-medium">{t("skills.page.installedSection")}</h2>
        </div>
        {isLoading ? (
          <div className="px-4 py-8 text-center text-muted-foreground">
            {t("common.loading")}
          </div>
        ) : sorted.length === 0 ? (
          <div className="px-4 py-8 text-center text-muted-foreground">
            {t("skills.page.empty")}
          </div>
        ) : (
          sorted.map((s) => (
            <SkillRow
              key={s.id}
              skill={s}
              onToggleEnabled={(id, next) => setEnabled.mutate({ id, enabled: next })}
              onDelete={(skill) => setPendingDelete(skill)}
              busy={setEnabled.isPending}
            />
          ))
        )}
      </section>

      {/* Library section — hidden in v1 (Plan 1 schema is inert until cloud sync ships). */}

      <DeleteSkillDialog
        skill={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onDeleted={() => setPendingDelete(null)}
      />
    </div>
  );
}
