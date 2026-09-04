import { describe, expect, it } from "vitest";
import {
  findKnownMeetingApp,
  getKnownMeetingApps,
} from "../../src/main/infra/mic-detector/known-meeting-apps";

/**
 * Invariants over the imported known-meeting-apps matrix.
 * The detection policy (Zoom priority 100 → browsers 60, per-app cooldowns)
 * consumes this table — the counts and priorities are contract, not styling.
 */
const REQUIRED_APPS = [
  ["Chrome", "com.google.Chrome"],
  ["Chrome Beta", "com.google.Chrome.beta"],
  ["Firefox", "org.mozilla.firefox"],
  ["Safari", "com.apple.Safari"],
  ["Microsoft Edge", "com.microsoft.edgemac"],
  ["Arc", "company.thebrowser.Browser"],
  ["Dia", "company.thebrowser.dia"],
  ["Brave Browser", "com.brave.Browser"],
  ["Vivaldi", "com.vivaldi.Vivaldi"],
  ["Opera", "com.operasoftware.Opera"],
  ["Zen Browser", "app.zen-browser.zen"],
  ["Comet", "ai.perplexity.comet"],
  ["ChatGPT Atlas", "com.openai.atlas"],
  ["Zoom", "us.zoom.xos"],
  ["Microsoft Teams", "com.microsoft.teams2"],
  ["Webex", "com.cisco.webexmeetingsapp"],
  ["Slack", "com.tinyspeck.slackmacgap"],
  ["FaceTime", "com.apple.FaceTime"],
  ["WhatsApp", "net.whatsapp.WhatsApp"],
  ["Discord", "com.hnc.Discord"],
  ["Aircall", "io.aircall.phone"],
  ["VooV Meeting", "com.tencent.tencentmeeting"],
  ["Tuple", "app.tuple.app"],
  ["Dialpad", "com.electron.dialpad"],
  ["Dialpad Meetings", "com.electron.uberconference"],
  ["Gather", "com.gather.Gather"],
  ["Gather V2", "com.gather.GatherV2"],
  ["ClickUp", "com.clickup.desktop-app"],
  ["Lark", "com.larksuite.larkApp"],
] as const;

const REQUIRED_ALIASES = [
  ["com.google.Chrome.helper", "Chrome"],
  ["com.google.Chrome.beta.helper", "Chrome Beta"],
  ["us.zoom.ZoomHybridConf", "Zoom"],
  ["us.zoom.ZoomPhone", "Zoom"],
  ["com.tinyspeck.slackmacgap.helper", "Slack"],
  ["company.thebrowser.browser.helper", "Arc"],
  ["Cisco-Systems.Spark", "Webex"],
  ["com.microsoft.teams2.modulehost", "Microsoft Teams"],
  ["com.apple.WebKit.GPU", "Safari"],
  ["io.aircall.phone.helper", "Aircall"],
  ["io.aircall.workspace.helper", "Aircall"],
  ["com.apple.avconferenced", "FaceTime"],
  ["com.microsoft.edgemac.helper", "Microsoft Edge"],
  ["com.brave.Browser.helper", "Brave Browser"],
  ["ai.perplexity.comet.helper", "Comet"],
  ["com.hnc.Discord.helper.Renderer", "Discord"],
  ["com.vivaldi.Vivaldi.helper", "Vivaldi"],
  ["com.openai.atlas.web.helper", "ChatGPT Atlas"],
  ["com.electron.dialpad.helper", "Dialpad"],
  ["com.electron.uberconference.helper", "Dialpad Meetings"],
  ["com.gather.Gather.helper", "Gather"],
  ["com.gather.GatherV2.helper", "Gather V2"],
  ["com.operasoftware.Opera.helper", "Opera"],
  ["com.clickup.desktop-app.helper", "ClickUp"],
  ["com.larksuite.larkApp.helper", "Lark"],
] as const;

describe("known-meeting-apps", () => {
  it("covers every supported application with a unique canonical bundle id", () => {
    const apps = getKnownMeetingApps();
    expect(apps).toHaveLength(REQUIRED_APPS.length);
    expect(new Set(apps.map((a) => a.bundleId)).size).toBe(
      REQUIRED_APPS.length,
    );
    for (const [displayName, bundleId] of REQUIRED_APPS) {
      expect(findKnownMeetingApp(bundleId)?.displayName).toBe(displayName);
    }
  });

  it("covers every required helper-process alias", () => {
    for (const [alias, displayName] of REQUIRED_ALIASES) {
      expect(findKnownMeetingApp(alias)?.displayName).toBe(displayName);
    }
  });

  it("keeps the priority ladder: Zoom 100 at the top, browsers at 60 or below", () => {
    const apps = getKnownMeetingApps();
    const zoom = apps.find((a) => a.bundleId === "us.zoom.xos");
    expect(zoom?.priority).toBe(100);
    expect(zoom?.category).toBe("native");
    expect(Math.max(...apps.map((a) => a.priority ?? 0))).toBe(100);

    const browsers = apps.filter((a) => a.category === "browser");
    expect(browsers.length).toBeGreaterThan(0);
    for (const browser of browsers) {
      expect(browser.priority ?? 0).toBeLessThanOrEqual(60);
    }
  });

  it("declares every app with a category and enabled-by-default flag", () => {
    for (const app of getKnownMeetingApps()) {
      expect(["native", "browser"]).toContain(app.category);
      expect(app.enabledByDefault).toBe(true);
      expect(app.displayName.length).toBeGreaterThan(0);
    }
  });

  it("looks up apps case-insensitively by bundle id and alias", () => {
    expect(findKnownMeetingApp("us.zoom.xos")?.displayName).toBe("Zoom");
    expect(findKnownMeetingApp("US.ZOOM.XOS")?.displayName).toBe("Zoom");
    // Windows process-name alias
    expect(findKnownMeetingApp("zoom.exe")?.displayName).toBe("Zoom");
    // macOS helper-process alias resolves to the parent browser
    expect(findKnownMeetingApp("com.google.Chrome.helper")?.displayName).toBe(
      "Chrome",
    );
    expect(findKnownMeetingApp("COM.GOOGLE.CHROME.HELPER")?.displayName).toBe(
      "Chrome",
    );
    expect(findKnownMeetingApp("com.example.unknown")).toBeUndefined();
  });

  it("returns a defensive copy from getKnownMeetingApps", () => {
    const first = getKnownMeetingApps();
    first.pop();
    expect(getKnownMeetingApps()).toHaveLength(REQUIRED_APPS.length);
  });
});
