import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ShortcutInput } from "@/components/shortcut-input";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

// TEMP: native helper bridge is disabled in Prismical, so the PTT / hands-free
// / paste-last-transcript / new-note shortcuts can't actually fire. Only the
// openApp shortcut works (via Electron's globalShortcut). The state + handlers
// + the rendered rows for the other shortcuts are kept below and gated behind
// NATIVE_SHORTCUTS_ENABLED — flip this back to `true` once the native bridge
// is re-enabled in service-manager.initializePlatformServices.
const NATIVE_SHORTCUTS_ENABLED = false;

export function ShortcutsSettingsPage() {
  const { t } = useTranslation();
  const [pushToTalkShortcut, setPushToTalkShortcut] = useState<number[]>([]);
  const [toggleRecordingShortcut, setToggleRecordingShortcut] = useState<
    number[]
  >([]);
  const [pasteLastTranscriptShortcut, setPasteLastTranscriptShortcut] =
    useState<number[]>([]);
  const [newNoteShortcut, setNewNoteShortcut] = useState<number[]>([]);
  const [openAppShortcut, setOpenAppShortcut] = useState<number[]>([]);
  const [recordingShortcut, setRecordingShortcut] = useState<
    | "pushToTalk"
    | "toggleRecording"
    | "pasteLastTranscript"
    | "newNote"
    | "openApp"
    | null
  >(null);

  // tRPC queries and mutations
  const shortcutsQuery = api.settings.getShortcuts.useQuery();
  const utils = api.useUtils();

  const setShortcutMutation = api.settings.setShortcut.useMutation({
    onSuccess: (data, variables) => {
      if (!data.success) {
        toast.error(t(data.error.key, data.error.params));
        const cached = utils.settings.getShortcuts.getData();
        if (cached) {
          setPushToTalkShortcut(cached.pushToTalk);
          setToggleRecordingShortcut(cached.toggleRecording);
          setPasteLastTranscriptShortcut(cached.pasteLastTranscript);
          setNewNoteShortcut(cached.newNote);
          setOpenAppShortcut(cached.openApp);
        } else {
          utils.settings.getShortcuts.invalidate();
        }
        return;
      }

      utils.settings.getShortcuts.invalidate();

      // Show warning if there is one
      if (data.warning) {
        toast.warning(t(data.warning.key, data.warning.params));
      } else {
        const successMessages = {
          pushToTalk: t("settings.shortcuts.toast.pushToTalkUpdated"),
          toggleRecording: t("settings.shortcuts.toast.handsFreeUpdated"),
          pasteLastTranscript: t(
            "settings.shortcuts.toast.pasteLastTranscriptUpdated",
          ),
          newNote: t("settings.shortcuts.toast.newNoteUpdated"),
          openApp: t("settings.shortcuts.toast.openAppUpdated"),
        } as const;
        toast.success(successMessages[variables.type]);
      }
    },
    onError: (error) => {
      console.error(error);
      toast.error(t("errors.generic"));
      const cached = utils.settings.getShortcuts.getData();
      if (cached) {
        setPushToTalkShortcut(cached.pushToTalk);
        setToggleRecordingShortcut(cached.toggleRecording);
        setPasteLastTranscriptShortcut(cached.pasteLastTranscript);
        setNewNoteShortcut(cached.newNote);
      } else {
        utils.settings.getShortcuts.invalidate();
      }
    },
  });

  // Load shortcuts when query data is available
  useEffect(() => {
    if (shortcutsQuery.data) {
      setPushToTalkShortcut(shortcutsQuery.data.pushToTalk);
      setToggleRecordingShortcut(shortcutsQuery.data.toggleRecording);
      setPasteLastTranscriptShortcut(shortcutsQuery.data.pasteLastTranscript);
      setNewNoteShortcut(shortcutsQuery.data.newNote);
      setOpenAppShortcut(shortcutsQuery.data.openApp);
    }
  }, [shortcutsQuery.data]);

  const handlePushToTalkChange = (shortcut: number[]) => {
    setPushToTalkShortcut(shortcut);
    setShortcutMutation.mutate({
      type: "pushToTalk",
      shortcut: shortcut,
    });
  };

  const handleToggleRecordingChange = (shortcut: number[]) => {
    setToggleRecordingShortcut(shortcut);
    setShortcutMutation.mutate({
      type: "toggleRecording",
      shortcut: shortcut,
    });
  };

  const handlePasteLastTranscriptChange = (shortcut: number[]) => {
    setPasteLastTranscriptShortcut(shortcut);
    setShortcutMutation.mutate({
      type: "pasteLastTranscript",
      shortcut: shortcut,
    });
  };

  const handleNewNoteChange = (shortcut: number[]) => {
    setNewNoteShortcut(shortcut);
    setShortcutMutation.mutate({
      type: "newNote",
      shortcut: shortcut,
    });
  };

  const handleOpenAppChange = (shortcut: number[]) => {
    setOpenAppShortcut(shortcut);
    setShortcutMutation.mutate({
      type: "openApp",
      shortcut: shortcut,
    });
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t("settings.shortcuts.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("settings.shortcuts.description")}
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-8">
            {/*
              TODO: un-gate these rows once the native helper bridge is back on.
              They're hidden today because the underlying key-capture layer is
              disabled, so saving a binding here wouldn't do anything.
            */}
            {NATIVE_SHORTCUTS_ENABLED && (
              <>
                <div>
                  <div className="flex flex-col md:flex-row md:justify-between gap-4">
                    <div>
                      <Label className="text-base font-semibold text-foreground">
                        {t("settings.shortcuts.pushToTalk.label")}
                      </Label>
                      <p className="text-xs text-muted-foreground mt-1 max-w-md">
                        {t("settings.shortcuts.pushToTalk.description")}
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 items-end min-w-[260px]">
                      <ShortcutInput
                        value={pushToTalkShortcut}
                        onChange={handlePushToTalkChange}
                        isRecordingShortcut={recordingShortcut === "pushToTalk"}
                        onRecordingShortcutChange={(recording) =>
                          setRecordingShortcut(recording ? "pushToTalk" : null)
                        }
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex flex-col md:flex-row md:justify-between gap-4">
                    <div>
                      <Label className="text-base font-semibold text-foreground">
                        {t("settings.shortcuts.handsFree.label")}
                      </Label>
                      <p className="text-xs text-muted-foreground mt-1 max-w-md">
                        {t("settings.shortcuts.handsFree.description")}
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 items-end min-w-[260px]">
                      <ShortcutInput
                        value={toggleRecordingShortcut}
                        onChange={handleToggleRecordingChange}
                        isRecordingShortcut={
                          recordingShortcut === "toggleRecording"
                        }
                        onRecordingShortcutChange={(recording) =>
                          setRecordingShortcut(
                            recording ? "toggleRecording" : null,
                          )
                        }
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex flex-col md:flex-row md:justify-between gap-4">
                    <div>
                      <Label className="text-base font-semibold text-foreground">
                        {t("settings.shortcuts.pasteLastTranscript.label")}
                      </Label>
                      <p className="text-xs text-muted-foreground mt-1 max-w-md">
                        {t("settings.shortcuts.pasteLastTranscript.description")}
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 items-end min-w-[260px]">
                      <ShortcutInput
                        value={pasteLastTranscriptShortcut}
                        onChange={handlePasteLastTranscriptChange}
                        isRecordingShortcut={
                          recordingShortcut === "pasteLastTranscript"
                        }
                        onRecordingShortcutChange={(recording) =>
                          setRecordingShortcut(
                            recording ? "pasteLastTranscript" : null,
                          )
                        }
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex flex-col md:flex-row md:justify-between gap-4">
                    <div>
                      <Label className="text-base font-semibold text-foreground">
                        {t("settings.shortcuts.newNote.label")}
                      </Label>
                      <p className="text-xs text-muted-foreground mt-1 max-w-md">
                        {t("settings.shortcuts.newNote.description")}
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 items-end min-w-[260px]">
                      <ShortcutInput
                        value={newNoteShortcut}
                        onChange={handleNewNoteChange}
                        isRecordingShortcut={recordingShortcut === "newNote"}
                        onRecordingShortcutChange={(recording) =>
                          setRecordingShortcut(recording ? "newNote" : null)
                        }
                      />
                    </div>
                  </div>
                </div>
              </>
            )}

            <div>
              <div className="flex flex-col md:flex-row md:justify-between gap-4">
                <div>
                  <Label className="text-base font-semibold text-foreground">
                    {t("settings.shortcuts.openApp.label")}
                  </Label>
                  <p className="text-xs text-muted-foreground mt-1 max-w-md">
                    {t("settings.shortcuts.openApp.description")}
                  </p>
                </div>
                <div className="flex flex-col gap-2 items-end min-w-[260px]">
                  <ShortcutInput
                    value={openAppShortcut}
                    onChange={handleOpenAppChange}
                    isRecordingShortcut={recordingShortcut === "openApp"}
                    onRecordingShortcutChange={(recording) =>
                      setRecordingShortcut(recording ? "openApp" : null)
                    }
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
