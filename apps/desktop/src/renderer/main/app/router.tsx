/**
 * Desktop TanStack hash route tree.
 *
 * Hash history, not browser history: the document is served from the privileged
 * `prismical-app://bundle/index.html` custom scheme, and hash changes never trip
 * the will-navigate origin confinement in main (windows/policy.ts). The tree
 * mirrors the browser client's route structure — the same shared @prismical/app-ui
 * screens, wrapped by the shared AppShell at the root. Screens are framework-free
 * and take resolved route params as props; each route component extracts
 * the param and hands it in, exactly as the web page.tsx wrappers do.
 *
 * Data hooks use the same main-owned WorkspaceTransport lane as the shared web UI,
 * while the renderer remains isolated from core addresses and bearer tokens.
 */
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Outlet,
  createHashHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { useLocation, useParams, useSearch } from "@tanstack/react-router";
import { usePorts, useSessionView } from "@prismical/app-client";
import type { AppModeValue } from "@prismical/desktop-contracts";
import { useDesktopEnv } from "./desktop-env";
import { FloatErrorFallback, FloatNoteView } from "./float-note-view";
import { LocalWorkspaceFooter } from "./local-workspace-footer";
import { AppModeSetting } from "./settings/app-mode-setting";
import { TelemetrySetting } from "./settings/telemetry-setting";
import { captureRendererException } from "../../telemetry";
import { LocalModelsScreen } from "./settings/local-models-screen";
import { AiProviderSetting } from "./settings/ai-provider-setting";
import { TranscriptionEngineSetting } from "./settings/transcription-engine-setting";
import { AppShell } from "@prismical/app-ui/shell/app-shell";
import { FeatureGate } from "@prismical/app-ui/shell/feature-gate";
import { HomeScreen } from "@prismical/app-ui/screens/home-screen";
import { NotesScreen } from "@prismical/app-ui/screens/notes-screen";
import { NoteDetailScreen } from "@prismical/app-ui/screens/note-detail-screen";
import { SharedScreen } from "@prismical/app-ui/screens/shared-screen";
import { PeopleScreen } from "@prismical/app-ui/screens/people-screen";
import { PersonDetailScreen } from "@prismical/app-ui/screens/person-detail-screen";
import { CompaniesScreen } from "@prismical/app-ui/screens/companies-screen";
import { CompanyDetailScreen } from "@prismical/app-ui/screens/company-detail-screen";
import { EventsScreen } from "@prismical/app-ui/screens/events-screen";
import { AcceptInvitationScreen } from "@prismical/app-ui/screens/accept-invitation-screen";
import { ShareAcceptScreen } from "@prismical/app-ui/screens/share-accept-screen";
import { NotFoundScreen } from "@prismical/app-ui/screens/not-found-screen";
import { AboutScreen } from "@prismical/app-ui/screens/settings/about-screen";
import { AccountScreen } from "@prismical/app-ui/screens/settings/account-screen";
import { AdvancedScreen } from "@prismical/app-ui/screens/settings/advanced-screen";
import { AiModelsScreen } from "@prismical/app-ui/screens/settings/ai-models/ai-models-screen";
import { ApiMcpScreen } from "@prismical/app-ui/screens/settings/api-mcp/api-mcp-screen";
import { AutomationDetailScreen } from "@prismical/app-ui/screens/settings/automations/automation-detail-screen";
import { CalendarScreen } from "@prismical/app-ui/screens/settings/calendar-screen";
import { BillingHandoffScreen } from "@prismical/app-ui/screens/settings/billing-handoff-screen";
import { TranscriptionScreen } from "@prismical/app-ui/screens/settings/transcription-screen";
import { IntegrationsScreen } from "@prismical/app-ui/screens/settings/integrations/integrations-screen";
import { IntegrationDetailScreen } from "@prismical/app-ui/screens/settings/integrations/integration-detail-screen";
import { MembersScreen } from "@prismical/app-ui/screens/settings/members-screen";
import { PreferencesScreen } from "@prismical/app-ui/screens/settings/preferences-screen";
import { ShortcutsScreen } from "@prismical/app-ui/screens/settings/shortcuts-screen";
import { SkillsScreen } from "@prismical/app-ui/screens/settings/skills/skills-screen";
import { SkillNewScreen } from "@prismical/app-ui/screens/settings/skills/skill-new-screen";
import { SkillEditorScreen } from "@prismical/app-ui/screens/settings/skills/skill-editor-screen";
import { VocabularyScreen } from "@prismical/app-ui/screens/settings/vocabulary-screen";
import { SkillsProvider } from "@prismical/app-ui/screens/settings/skills/components/skills-store";
import {
  AccountSwitcher,
  DESKTOP_ACCOUNT_SWITCHER_TEST_IDS,
} from "@prismical/app-ui/shell/account-switcher";

// --- Root: the shared shell wraps every routed screen ----------------------

// The sidebar-footer account slot, filled with the SAME <AccountSwitcher> as
// the browser client — accounts, org switching, Members, Add organization, theme and sign
// out, all driven through the ports seam. It replaced desktop's bespoke
// session-view-only switcher, which existed only because the REST lane
// wasn't real yet. `testIds` keeps this suite's `desktop-*` hooks unchanged.
function RootLayout() {
  // The floating note window rides the same router at
  // /float[/:noteId] but renders BARE — no AppShell (sidebar/header/cluster);
  // FloatNoteView carries its own chrome + recording dock.
  const pathname = useLocation({ select: (location) => location.pathname });
  // Desktop-owned, so the mode is read here: the shell's accountSwitcher
  // slot holds the shared AccountSwitcher in cloud mode and the local-workspace
  // footer in local mode — no shared code learns the mode.
  const { appMode } = useDesktopEnv();
  if (pathname.startsWith("/float")) return <Outlet />;
  return (
    <AppShell
      accountSwitcher={
        appMode === "local" ? (
          <LocalWorkspaceFooter />
        ) : (
          <AccountSwitcher testIds={DESKTOP_ACCOUNT_SWITCHER_TEST_IDS} />
        )
      }
    >
      <Outlet />
    </AppShell>
  );
}

/** RouterProvider (mount.tsx) supplies the boot mode through the router context. */
interface DesktopRouterContext {
  readonly appMode: AppModeValue;
}

const rootRoute = createRootRouteWithContext<DesktopRouterContext>()({ component: RootLayout });

const child = (path: string, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

/**
 * A cloud-only route: in local mode it redirects home from
 * `beforeLoad` — hiding the nav entry is not enough on desktop, where main
 * pushes paths onto this router (deep links, tray, menu) and a hash is typeable.
 * A named feature adds the org gate used by the sidebar. A null feature
 * makes the surface available to every cloud org while retaining the local redirect.
 */
const cloudOnly = (path: string, feature: string | null, component: () => React.ReactNode) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: ({ context }) => {
      if (context.appMode === "local") throw redirect({ to: "/home" });
    },
    component: function CloudOnlyRoute() {
      const screen = React.createElement(component);
      return feature ? <FeatureGate feature={feature}>{screen}</FeatureGate> : screen;
    },
  });

// --- Route components that unwrap a param / supply desktop auth wiring ------

function NoteDetailRoute() {
  const { noteId } = useParams({ strict: false }) as { noteId: string };
  return <NoteDetailScreen noteId={noteId} />;
}

function FloatRoute() {
  const { noteId } = useParams({ strict: false }) as { noteId?: string };
  // Dock-initiated starts ride ?fresh=1&autostart=1 (the expansion rule) — set
  // only by main's FloatBridge, consumed once here.
  const search = useSearch({ strict: false }) as { fresh?: unknown; autostart?: unknown };
  return (
    <FloatNoteView
      noteId={noteId}
      fresh={Boolean(search.fresh)}
      autoStart={Boolean(search.autostart)}
    />
  );
}

function PersonDetailRoute() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <PersonDetailScreen id={id} />;
}

function CompanyDetailRoute() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <CompanyDetailScreen id={id} />;
}

function ShareAcceptRoute() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <ShareAcceptScreen id={id} />;
}

function AutomationDetailRoute() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <AutomationDetailScreen id={id} />;
}

function IntegrationDetailRoute() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <IntegrationDetailScreen id={id} />;
}

function SkillEditorRoute() {
  const { skillId } = useParams({ strict: false }) as { skillId: string };
  return <SkillEditorScreen skillId={skillId} />;
}

// The shared TranscriptionScreen renders the
// desktop-owned engine card through its named `engineSettings` slot — web
// passes nothing and keeps its own controls.
function TranscriptionRoute() {
  return <TranscriptionScreen engineSettings={<TranscriptionEngineSetting />} />;
}

// The shared AI-models screen renders the desktop-owned
// provider card (BYO key / Ollama) through its named `providerSettings` slot.
function AiModelsRoute() {
  return <AiModelsScreen providerSettings={<AiProviderSetting />} />;
}

// The shared Advanced screen renders the desktop-owned
// app-mode switch card through its named `modeSettings` slot.
function AdvancedRoute() {
  return <AdvancedScreen modeSettings={<><TelemetrySetting /><AppModeSetting /></>} />;
}

function useActiveEmail(): string {
  const session = useSessionView();
  return session.accounts.find((account) => account.sub === session.activeSub)?.email ?? "";
}

// The two auth-wired screens: web passes these from AuthProvider; desktop reads
// the sanitized session view + AuthPort, whose switchOrg/addAccount are the
// re-scope adapters (fire-and-forget; the session-changed push
// drives the UI). AccountScreen takes only email + onSignOut.
function AccountRoute() {
  const { auth } = usePorts();
  return <AccountScreen email={useActiveEmail()} onSignOut={() => void auth.signOut()} />;
}

function AcceptInvitationRoute() {
  const { id } = useParams({ strict: false }) as { id?: string };
  const { auth } = usePorts();
  return (
    <AcceptInvitationScreen
      id={id ?? null}
      currentEmail={useActiveEmail()}
      onSwitchOrg={(orgId) => auth.switchOrg(orgId)}
      onAddAccount={() => void auth.signIn()}
    />
  );
}

// --- The tree --------------------------------------------------------------

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/home" });
  },
});

const automationsRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/automations",
  beforeLoad: () => {
    throw redirect({ to: "/settings/integrations" });
  },
});

const automationDetailRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/automations/$id",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/settings/integrations/automations/$id",
      params: { id: params.id },
    });
  },
});

// Skills settings share an in-memory SkillsProvider across list/new/editor — a
// layout route mirrors the browser client's nested skills-settings route.
const skillsLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings/skills",
  component: function SkillsLayout() {
    return (
      <SkillsProvider>
        <Outlet />
      </SkillsProvider>
    );
  },
});
const skillsIndexRoute = createRoute({
  getParentRoute: () => skillsLayoutRoute,
  path: "/",
  component: SkillsScreen,
});
const skillNewRoute = createRoute({
  getParentRoute: () => skillsLayoutRoute,
  path: "new",
  component: SkillNewScreen,
});
const skillEditorRoute = createRoute({
  getParentRoute: () => skillsLayoutRoute,
  path: "$skillId",
  component: SkillEditorRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  child("home", HomeScreen),
  child("notes", NotesScreen),
  child("notes/$noteId", NoteDetailRoute),
  // The floating note window's routes — bare (no AppShell,
  // see RootLayout). Only the float-note BrowserWindow ever lands here. Their
  // OWN error component: the router default would strip the window chrome
  // off an always-on-top window (no way to dismiss it) — the fallback keeps
  // working collapse/dock-back controls and a reload.
  createRoute({
    getParentRoute: () => rootRoute,
    path: "float",
    component: FloatRoute,
    errorComponent: FloatErrorFallback,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "float/$noteId",
    component: FloatRoute,
    errorComponent: FloatErrorFallback,
  }),
  // Cloud-only surfaces: sharing, the people directory,
  // calendars, organizations/invitations, the account, billing, the public
  // API and automations — redirected home in local mode. The directory is
  // available to every cloud org; other surfaces retain their org feature gates.
  cloudOnly("shared", "sharing", SharedScreen),
  cloudOnly("people", null, PeopleScreen),
  cloudOnly("people/$id", null, PersonDetailRoute),
  cloudOnly("companies", null, CompaniesScreen),
  cloudOnly("companies/$id", null, CompanyDetailRoute),
  cloudOnly("events", "calendar", EventsScreen),
  cloudOnly("accept-invitation/$id", "organization", AcceptInvitationRoute),
  cloudOnly("share/accept/$id", "sharing", ShareAcceptRoute),
  child("settings/about", AboutScreen),
  cloudOnly("settings/account", "account", AccountRoute),
  child("settings/advanced", AdvancedRoute),
  child("settings/ai-models", AiModelsRoute),
  cloudOnly("settings/api-keys", "publicApi", ApiMcpScreen),
  cloudOnly("settings/calendar", "calendar", CalendarScreen),
  cloudOnly("settings/billing", "billing", BillingHandoffScreen),
  child("settings/transcription", TranscriptionRoute),
  child("settings/dictation", TranscriptionRoute),
  // Desktop-owned; its nav entry is gated on the 'local-models' capability.
  child("settings/local-models", LocalModelsScreen),
  cloudOnly("settings/integrations", "automations", IntegrationsScreen),
  cloudOnly("settings/integrations/automations/$id", "automations", AutomationDetailRoute),
  cloudOnly("settings/integrations/$id", "automations", IntegrationDetailRoute),
  automationsRedirectRoute,
  automationDetailRedirectRoute,
  cloudOnly("settings/members", "organization", MembersScreen),
  child("settings/preferences", PreferencesScreen),
  child("settings/shortcuts", ShortcutsScreen),
  skillsLayoutRoute.addChildren([skillsIndexRoute, skillNewRoute, skillEditorRoute]),
  child("settings/vocabulary", VocabularyScreen),
]);

function RouteError({ error }: { error: unknown }) {
  React.useEffect(() => captureRendererException(window.desktop.telemetry, error, 'react_error_boundary'), [error]);
  const { t } = useTranslation();
  // Per-route isolation: a screen that throws shows this instead of blanking
  // the shell.
  return (
    <div className="space-y-1 p-6" data-testid="route-error">
      <p className="text-sm font-medium">{t("desktop.routeError.title")}</p>
      <p className="text-sm text-muted-foreground">{t("desktop.routeError.description")}</p>
    </div>
  );
}

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  // Overridden per mount by RouterProvider's `context` (mount.tsx) with the
  // boot-resolved mode; this default only satisfies the type.
  context: { appMode: "cloud" },
  defaultNotFoundComponent: () => <NotFoundScreen />,
  defaultErrorComponent: RouteError,
});
