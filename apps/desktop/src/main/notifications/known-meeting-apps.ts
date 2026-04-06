import type { KnownMeetingApp } from "@/types/meeting-start-notifications";

const KNOWN_MEETING_APPS: KnownMeetingApp[] = [
  {
    bundleId: "us.zoom.xos",
    displayName: "Zoom",
    category: "native",
    enabledByDefault: true,
    priority: 100,
  },
  {
    bundleId: "com.microsoft.teams2",
    displayName: "Microsoft Teams",
    category: "native",
    enabledByDefault: true,
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
    ],
    priority: 90,
  },
  {
    bundleId: "com.cisco.webexmeetingsapp",
    displayName: "Webex",
    category: "native",
    enabledByDefault: true,
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
    ],
    priority: 80,
  },
  {
    bundleId: "net.whatsapp.WhatsApp",
    displayName: "WhatsApp",
    category: "native",
    enabledByDefault: true,
    priority: 75,
  },
  {
    bundleId: "app.tuple.app",
    displayName: "Tuple",
    category: "native",
    enabledByDefault: true,
    priority: 85,
  },
  {
    bundleId: "io.aircall.phone",
    displayName: "Aircall",
    category: "native",
    enabledByDefault: true,
    priority: 70,
  },
  {
    bundleId: "com.tencent.tencentmeeting",
    displayName: "VooV Meeting",
    category: "native",
    enabledByDefault: true,
    priority: 70,
  },
  {
    bundleId: "com.electron.dialpad",
    displayName: "Dialpad",
    category: "native",
    enabledByDefault: true,
    priority: 70,
  },
  {
    bundleId: "com.electron.uberconference",
    displayName: "Dialpad Meetings",
    category: "native",
    enabledByDefault: true,
    priority: 70,
  },
  {
    bundleId: "com.gather.Gather",
    displayName: "Gather",
    category: "native",
    enabledByDefault: true,
    priority: 70,
  },
  {
    bundleId: "com.google.Chrome",
    displayName: "Chrome",
    category: "browser",
    enabledByDefault: true,
    aliases: ["com.google.Chrome.helper"],
    priority: 60,
  },
  {
    bundleId: "company.thebrowser.Browser",
    displayName: "Arc",
    category: "browser",
    enabledByDefault: true,
    aliases: ["company.thebrowser.Browser.helper"],
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
    aliases: ["com.brave.Browser.helper"],
    priority: 60,
  },
  {
    bundleId: "com.microsoft.edgemac",
    displayName: "Microsoft Edge",
    category: "browser",
    enabledByDefault: true,
    aliases: ["com.microsoft.edgemac.helper"],
    priority: 60,
  },
  {
    bundleId: "com.vivaldi.Vivaldi",
    displayName: "Vivaldi",
    category: "browser",
    enabledByDefault: true,
    aliases: ["com.vivaldi.Vivaldi.helper"],
    priority: 60,
  },
  {
    bundleId: "app.zen-browser.zen",
    displayName: "Zen Browser",
    category: "browser",
    enabledByDefault: true,
    aliases: ["app.zen-browser.zen.helper"],
    priority: 60,
  },
  {
    bundleId: "ai.perplexity.comet",
    displayName: "Perplexity",
    category: "browser",
    enabledByDefault: true,
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
