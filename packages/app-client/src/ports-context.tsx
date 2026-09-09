"use client";

// The shared ports context. Framework-free of Next —
// it imports only react + @prismical/app-contracts and uses no "@/" alias.
// Shared data hooks for connections, collaboration, organizations, and queries
// consume it here because app-client is the lowest React layer both shells and
// app-ui can import from. Web adapters stay in the web app; app-ui imports these
// hooks from here.

import * as React from "react";
import type { WorkflowRuntime } from "@prismical/app-workflow";
import type { RecordingSessionClient } from "./workflow/recording-session";
import type {
  AnalyticsPort,
  AppLinkProps,
  AppSearchParams,
  AssetPort,
  AuthPort,
  DesktopCapabilityPort,
  EnvDescriptor,
  EnvPort,
  ExternalPort,
  NavigationActions,
  NavigationPort,
  RecordingPort,
  RouteParams,
  SessionView,
} from "@prismical/app-contracts";

/**
 * Props of the platform link component: the framework-free AppLinkProps
 * contract plus standard anchor props. The shared <AppLink> component in
 * app-ui renders `navigation.Link` — web supplies next/link
 * (keeping its prefetch behavior), desktop the TanStack router link.
 */
export type AppLinkComponentProps = AppLinkProps &
  Omit<React.ComponentPropsWithoutRef<"a">, "href"> &
  React.RefAttributes<HTMLAnchorElement>;

/** NavigationPort plus the platform link renderer (a React concern, so it
 *  lives here rather than in the framework-free contract). */
export interface NavigationAdapter extends NavigationPort {
  readonly Link: React.ComponentType<AppLinkComponentProps>;
}

/** The full port set a platform provider supplies. Identity MUST be stable
 *  for the life of the app — reactivity flows through the ports' own
 *  subscription surfaces (AuthPort.onSessionChanged) and hook members, never
 *  through context-value churn. */
export interface AppPorts {
  readonly navigation: NavigationAdapter;
  readonly env: EnvPort;
  readonly auth: AuthPort;
  readonly assets: AssetPort;
  readonly external: ExternalPort;
  readonly desktopCapabilities: DesktopCapabilityPort;
  readonly analytics: AnalyticsPort;
  // The recording chunk-upload lane — the web adapter uploads raw WAV;
  // desktop's record button routes to main's native pipeline (RecordingPort
  // unimplemented there). Consumed by lib/recording's useRecording.
  readonly recording: RecordingPort;
  /** Optional until each platform adopts the shared workflow owner. */
  readonly workflow?: WorkflowRuntime;
  readonly recordingSession?: RecordingSessionClient;
}

const PortsContext = React.createContext<AppPorts | null>(null);

export function PortsProvider({
  ports,
  children,
}: {
  ports: AppPorts;
  children: React.ReactNode;
}) {
  return <PortsContext.Provider value={ports}>{children}</PortsContext.Provider>;
}

export function usePorts(): AppPorts {
  const ctx = React.useContext(PortsContext);
  if (!ctx) throw new Error("usePorts must be used within a PortsProvider");
  return ctx;
}

// Convenience hooks named like their next/navigation counterparts so moves are mechanical.

export function useNavigation(): NavigationActions {
  return usePorts().navigation.useNavigation();
}

export function usePathname(): string {
  return usePorts().navigation.usePathname();
}

export function useSearchParams(): AppSearchParams {
  return usePorts().navigation.useSearchParams();
}

export function useParams<T extends RouteParams = RouteParams>(): T {
  return usePorts().navigation.useParams<T>();
}

/** The injected environment, memoized per provider (it never changes within a
 *  session, and a stable identity keeps it safe in dependency arrays). */
export function useEnv(): EnvDescriptor {
  const { env } = usePorts();
  return React.useMemo(() => env.getEnv(), [env]);
}

/** Reactive sanitized session view over AuthPort's subscription surface. */
export function useSessionView(): SessionView {
  const { auth } = usePorts();
  const subscribe = React.useCallback(
    (onStoreChange: () => void) => auth.onSessionChanged(onStoreChange),
    [auth],
  );
  const getSnapshot = React.useCallback(() => auth.getSession(), [auth]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Reactive active-account / active-org over the session view — drop-in
// replacements for the web AuthProvider's useActiveAccountId/useActiveOrgId, so
// the moved data code (query-client org reset, note collab, org hooks) reads
// org/account scope from the port instead of a web-only context. The
// active org is the active account's `activeOrgId` (the view carries per-account
// org; only the active account's is populated on web).

/** The active account id (session subject), or null when signed out. */
export function useActiveAccountId(): string | null {
  return useSessionView().activeSub ?? null;
}

/** The exact active login identity (falls back to user subject on desktop). */
export function useActiveSessionKey(): string | null {
  const view = useSessionView();
  return view.activeSessionKey ?? view.activeSub ?? null;
}

/** The active org id in a session view. Pure, so non-reactive readers can share the rule. */
export function activeOrgIdOf(view: SessionView): string | null {
  const activeSessionKey = view.activeSessionKey ?? view.activeSub;
  return (
    view.accounts.find((a) => (a.sessionKey ?? a.sub) === activeSessionKey)?.activeOrgId ??
    null
  );
}

/** The active organization id, or null until one is selected. */
export function useActiveOrgId(): string | null {
  return activeOrgIdOf(useSessionView());
}
