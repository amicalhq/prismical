import type { KnownMeetingApp } from "@/types/meeting-start-notifications";

const KNOWN_MEETING_APPS: KnownMeetingApp[] = [
  {
    bundleId: "us.zoom.xos",
    displayName: "Zoom",
    category: "native",
    enabledByDefault: true,
    aliases: ["zoom.exe", "zoomphone.exe", "cptserv.exe"],
    priority: 100,
  },
  {
    bundleId: "com.microsoft.teams2",
    displayName: "Microsoft Teams",
    category: "native",
    enabledByDefault: true,
    aliases: ["ms-teams.exe", "teams.exe"],
    priority: 95,
  },
  {
    bundleId: "com.tinyspeck.slackmacgap",
    displayName: "Slack",
    category: "native",
    enabledByDefault: true,
    aliases: [
      "com.tinyspeck.slackmacgap.helper",
      "com.tinyspeck.slackmacgap.helper.plugin",
      "com.tinyspeck.slackmacgap.helper.renderer",
      "slack.exe",
    ],
    priority: 90,
  },
  {
    bundleId: "com.cisco.webexmeetingsapp",
    displayName: "Webex",
    category: "native",
    enabledByDefault: true,
    aliases: ["webex.exe", "ciscocollabhost.exe", "atmgr.exe"],
    priority: 90,
  },
  {
    bundleId: "com.hnc.Discord",
    displayName: "Discord",
    category: "native",
    enabledByDefault: true,
    aliases: [
      "com.hnc.discord.helper",
      "com.hnc.discord.helper.plugin",
      "com.hnc.discord.helper.renderer",
      "discord.exe",
    ],
    priority: 80,
  },
  {
    bundleId: "net.whatsapp.WhatsApp",
    displayName: "WhatsApp",
    category: "native",
    enabledByDefault: true,
    aliases: ["whatsapp.exe"],
    priority: 75,
  },
  {
    bundleId: "app.tuple.app",
    displayName: "Tuple",
    category: "native",
    enabledByDefault: true,
    aliases: ["tuple.exe"],
    priority: 85,
  },
  {
    bundleId: "io.aircall.phone",
    displayName: "Aircall",
    category: "native",
    enabledByDefault: true,
    aliases: ["aircall.exe"],
    priority: 70,
  },
  {
    bundleId: "com.tencent.tencentmeeting",
    displayName: "VooV Meeting",
    category: "native",
    enabledByDefault: true,
    aliases: ["voovmeeting.exe", "wemeetapp.exe"],
    priority: 70,
  },
  {
    bundleId: "com.electron.dialpad",
    displayName: "Dialpad",
    category: "native",
    enabledByDefault: true,
    aliases: ["dialpad.exe"],
    priority: 70,
  },
  {
    bundleId: "com.electron.uberconference",
    displayName: "Dialpad Meetings",
    category: "native",
    enabledByDefault: true,
    aliases: ["uberconference.exe", "dialpadmeetings.exe"],
    priority: 70,
  },
  {
    bundleId: "com.gather.Gather",
    displayName: "Gather",
    category: "native",
    enabledByDefault: true,
    aliases: ["gather.exe"],
    priority: 70,
  },
  {
    bundleId: "com.google.Chrome",
    displayName: "Chrome",
    category: "browser",
    enabledByDefault: true,
    aliases: ["com.google.Chrome.helper", "chrome.exe"],
    priority: 60,
  },
  {
    bundleId: "company.thebrowser.Browser",
    displayName: "Arc",
    category: "browser",
    enabledByDefault: true,
    aliases: ["company.thebrowser.Browser.helper", "arc.exe"],
    priority: 60,
  },
  {
    bundleId: "org.mozilla.firefox",
    displayName: "Firefox",
    category: "browser",
    enabledByDefault: true,
    aliases: [
      "org.mozilla.firefox.helper",
      "org.mozilla.firefoxdeveloperedition.helper",
      "firefox.exe",
    ],
    priority: 60,
  },
  {
    bundleId: "com.apple.Safari",
    displayName: "Safari",
    category: "browser",
    enabledByDefault: true,
    priority: 60,
  },
  {
    bundleId: "com.brave.Browser",
    displayName: "Brave",
    category: "browser",
    enabledByDefault: true,
    aliases: ["com.brave.Browser.helper", "brave.exe"],
    priority: 60,
  },
  {
    bundleId: "com.microsoft.edgemac",
    displayName: "Microsoft Edge",
    category: "browser",
    enabledByDefault: true,
    aliases: ["com.microsoft.edgemac.helper", "msedge.exe"],
    priority: 60,
  },
  {
    bundleId: "com.vivaldi.Vivaldi",
    displayName: "Vivaldi",
    category: "browser",
    enabledByDefault: true,
    aliases: ["com.vivaldi.Vivaldi.helper", "vivaldi.exe"],
    priority: 60,
  },
  {
    bundleId: "app.zen-browser.zen",
    displayName: "Zen Browser",
    category: "browser",
    enabledByDefault: true,
    aliases: ["app.zen-browser.zen.helper", "zen.exe"],
    priority: 60,
  },
  {
    bundleId: "ai.perplexity.comet",
    displayName: "Perplexity",
    category: "browser",
    enabledByDefault: true,
    aliases: ["comet.exe", "perplexity.exe"],
    priority: 55,
  },
];

const KNOWN_MEETING_APPS_BY_BUNDLE_ID = new Map(
  KNOWN_MEETING_APPS.flatMap((app) => [
    [app.bundleId.toLowerCase(), app] as const,
    ...(app.aliases ?? []).map((alias) => [alias.toLowerCase(), app] as const),
  ]),
);

export function getKnownMeetingApps(): KnownMeetingApp[] {
  return [...KNOWN_MEETING_APPS];
}

export function findKnownMeetingApp(
  bundleId: string,
): KnownMeetingApp | undefined {
  return KNOWN_MEETING_APPS_BY_BUNDLE_ID.get(bundleId.toLowerCase());
}
