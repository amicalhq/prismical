import React, { useEffect, useState } from "react";
import { api } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  CheckCircle,
  AlertCircle,
  Mic,
  Monitor,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { OnboardingLayout } from "../shared/OnboardingLayout";
import { NavigationButtons } from "../shared/NavigationButtons";
import { useTranslation } from "react-i18next";

interface PermissionsScreenProps {
  onNext: () => void;
  onBack: () => void;
  permissions: {
    microphone: "granted" | "denied" | "not-determined";
    screenRecording: boolean;
  };
  platform: string;
  checkPermissions: () => Promise<void>;
}

/**
 * Permissions screen - handles microphone and screen recording permissions
 * Based on the existing UnifiedPermissionsStep component
 */
export function PermissionsScreen({
  onNext,
  onBack,
  permissions,
  platform,
  checkPermissions,
}: PermissionsScreenProps) {
  const { t } = useTranslation();
  const [isRequestingMic, setIsRequestingMic] = useState(false);
  const [isPolling, setIsPolling] = useState(false);

  // tRPC mutations
  const requestMicPermission =
    api.onboarding.requestMicrophonePermission.useMutation();
  const openExternal = api.onboarding.openExternal.useMutation();

  const allPermissionsGranted =
    permissions.microphone === "granted" &&
    (permissions.screenRecording || platform !== "darwin");

  // Poll for permission changes continuously to keep UI in sync
  useEffect(() => {
    // Always poll to detect permission changes in real-time
    const interval = setInterval(async () => {
      await checkPermissions();
    }, 2000);

    // Show polling indicator only when permissions are not all granted
    setIsPolling(!allPermissionsGranted);

    return () => {
      clearInterval(interval);
    };
  }, [checkPermissions, allPermissionsGranted]);

  const handleRequestMicrophone = async () => {
    setIsRequestingMic(true);
    try {
      await requestMicPermission.mutateAsync();
      await checkPermissions();
    } finally {
      setIsRequestingMic(false);
    }
  };

  const handleOpenScreenRecording = async () => {
    // Open System Preferences > Security & Privacy > Privacy > Screen Recording
    await openExternal.mutateAsync({
      url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    });
  };

  const handleOpenMicrophoneSettings = async () => {
    // Open platform-specific microphone privacy settings
    const url =
      platform === "darwin"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        : "ms-settings:privacy-microphone";
    await openExternal.mutateAsync({ url });
  };

  const getMicrophoneStatus = () => {
    switch (permissions.microphone) {
      case "granted":
        return {
          icon: CheckCircle,
          color: "text-green-500",
          bg: "bg-green-500/10",
        };
      case "denied":
        return {
          icon: AlertCircle,
          color: "text-red-500",
          bg: "bg-red-500/10",
        };
      default:
        return {
          icon: RefreshCw,
          color: "text-blue-500",
          bg: "bg-blue-500/10",
        };
    }
  };

  const getScreenRecordingStatus = () => {
    if (permissions.screenRecording) {
      return {
        icon: CheckCircle,
        color: "text-green-500",
        bg: "bg-green-500/10",
      };
    } else {
      return {
        icon: AlertCircle,
        color: "text-yellow-500",
        bg: "bg-yellow-500/10",
      };
    }
  };

  const micStatus = getMicrophoneStatus();
  const scrStatus = getScreenRecordingStatus();
  const MicIcon = micStatus.icon;
  const ScrIcon = scrStatus.icon;

  return (
    <OnboardingLayout
      title={t("onboarding.permissions.title")}
      subtitle={t("onboarding.permissions.subtitle")}
      footer={
        <NavigationButtons
          onBack={onBack}
          onNext={onNext}
          disableNext={!allPermissionsGranted}
          nextLabel={
            allPermissionsGranted
              ? t("onboarding.navigation.continue")
              : t("onboarding.permissions.waiting")
          }
        />
      }
    >
      <div className="space-y-6">
        {/* Status Summary */}
        {allPermissionsGranted && (
          <Card className="border-green-500 bg-green-500/10 p-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <div>
                <p className="font-medium text-green-900 dark:text-green-100">
                  {t("onboarding.permissions.allGranted.title")}
                </p>
                <p className="text-sm text-green-800 dark:text-green-200">
                  {t("onboarding.permissions.allGranted.description")}
                </p>
              </div>
            </div>
          </Card>
        )}

        {/* Polling Status */}
        {isPolling && !allPermissionsGranted && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span>{t("onboarding.permissions.polling")}</span>
          </div>
        )}

        {/* Permission Cards */}
        <div className="space-y-4">
          {/* Microphone Permission */}
          <Card className="p-6">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className={`mt-1 rounded-lg p-2 ${micStatus.bg}`}>
                  <Mic className={`h-5 w-5 ${micStatus.color}`} />
                </div>
                <div>
                  <h3 className="font-medium">
                    {t("onboarding.permissions.microphone.title")}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("onboarding.permissions.microphone.description")}
                  </p>

                  {permissions.microphone === "granted" && (
                    <div className="mt-2 flex items-center gap-2">
                      <MicIcon className={`h-4 w-4 ${micStatus.color}`} />
                      <span className="text-sm font-medium text-green-600 dark:text-green-400">
                        {t("onboarding.permissions.status.granted")}
                      </span>
                    </div>
                  )}

                  {permissions.microphone === "denied" && (
                    <div className="mt-2 space-y-2">
                      <div className="flex items-center gap-2">
                        <MicIcon className={`h-4 w-4 ${micStatus.color}`} />
                        <span className="text-sm font-medium text-red-600 dark:text-red-400">
                          {t("onboarding.permissions.status.denied")}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {t("onboarding.permissions.microphone.deniedHelp")}
                      </p>
                    </div>
                  )}

                  {permissions.microphone === "not-determined" && (
                    <div className="mt-2 flex items-center gap-2">
                      <MicIcon className={`h-4 w-4 ${micStatus.color}`} />
                      <span className="text-sm font-medium">
                        {t("onboarding.permissions.status.notRequested")}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {permissions.microphone !== "granted" && (
                <div className="flex flex-col gap-2">
                  {permissions.microphone === "not-determined" && (
                    <Button
                      onClick={handleRequestMicrophone}
                      disabled={isRequestingMic}
                      size="sm"
                      variant="default"
                    >
                      {isRequestingMic
                        ? t("onboarding.permissions.actions.requesting")
                        : t("onboarding.permissions.actions.request")}
                    </Button>
                  )}

                  {permissions.microphone === "denied" && (
                    <Button
                      onClick={handleOpenMicrophoneSettings}
                      size="sm"
                      variant="outline"
                      className="gap-2"
                    >
                      <ExternalLink className="h-4 w-4" />
                      {t("onboarding.permissions.actions.openSettings")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Card>

          {/* Screen Recording Permission (macOS only) */}
          {platform === "darwin" && (
            <Card className="p-6">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className={`mt-1 rounded-lg p-2 ${scrStatus.bg}`}>
                    <Monitor className={`h-5 w-5 ${scrStatus.color}`} />
                  </div>
                  <div>
                    <h3 className="font-medium">
                      {t("onboarding.permissions.screenRecording.title")}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("onboarding.permissions.screenRecording.description")}
                    </p>

                    {permissions.screenRecording ? (
                      <div className="mt-2 flex items-center gap-2">
                        <ScrIcon className={`h-4 w-4 ${scrStatus.color}`} />
                        <span className="text-sm font-medium text-green-600 dark:text-green-400">
                          {t("onboarding.permissions.status.granted")}
                        </span>
                      </div>
                    ) : (
                      <div className="mt-2 space-y-2">
                        <div className="flex items-center gap-2">
                          <ScrIcon className={`h-4 w-4 ${scrStatus.color}`} />
                          <span className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                            {t("onboarding.permissions.status.required")}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {t(
                            "onboarding.permissions.screenRecording.deniedHelp",
                          )}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {!permissions.screenRecording && (
                  <Button
                    onClick={handleOpenScreenRecording}
                    size="sm"
                    variant="outline"
                    className="gap-2"
                  >
                    <ExternalLink className="h-4 w-4" />
                    {t("onboarding.permissions.actions.openSettings")}
                  </Button>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </OnboardingLayout>
  );
}
