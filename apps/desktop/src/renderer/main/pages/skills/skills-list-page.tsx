import { useRef } from "react";
import { Link } from "@tanstack/react-router";
import { IconPlus, IconUpload } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { api } from "@/trpc/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { SkillCard } from "./components/skill-card";

export function SkillsListPage() {
  const { t } = useTranslation();
  const { data: skills = [], isLoading } = api.skills.list.useQuery({});
  const utils = api.useUtils();

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
    // Explicit whitelist — earlier "anything-not-.md → JSON" rule turned
    // unsupported extensions (e.g. .txt, .markdown) into a confusing JSON
    // parse error toast. Reject upfront with a clear message instead.
    let format: "json" | "markdown";
    if (ext === "md" || ext === "markdown") {
      format = "markdown";
    } else if (ext === "json") {
      format = "json";
    } else {
      toast.error(
        `Unsupported file type ".${ext ?? ""}" — choose a .json or .md file.`,
      );
      event.target.value = "";
      return;
    }

    const content = await file.text();
    importMutation.mutate({ format, content });

    // Reset input so the same file can be re-imported if needed
    event.target.value = "";
  };

  // Sort: system skills first (descending), then user-created by createdAt desc.
  const sorted = [...skills].sort((a, b) => {
    if (a.system !== b.system) return a.system ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div className="max-w-5xl mx-auto p-8 space-y-6">
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

      <section>
        <h2 className="mb-3 font-medium">
          {t("skills.page.installedSection")}
        </h2>
        {isLoading ? (
          <div className="rounded-lg border bg-card px-4 py-8 text-center text-muted-foreground">
            {t("common.loading")}
          </div>
        ) : sorted.length === 0 ? (
          <div className="rounded-lg border bg-card px-4 py-8 text-center text-muted-foreground">
            {t("skills.page.empty")}
          </div>
        ) : (
          <div className="grid auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((s) => (
              <SkillCard key={s.id} skill={s} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
