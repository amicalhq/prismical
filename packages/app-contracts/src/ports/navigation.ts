// NavigationPort — navigation seam shared by the renderers.
//
// The contract is hook-shaped on purpose: the measured web surface IS a set of
// Next hooks (census: useRouter push ×20 / replace ×13, zero back/refresh/
// prefetch at call sites; usePathname 9 files; useSearchParams 9 files;
// useParams 6 files), and delegating hook-for-hook is the only way the web
// adapter preserves Next's semantics bit-for-bit — reactive pathname+search,
// pathname identity changing on path change only (the (app)/layout.tsx page
// transition keys on it), and the Suspense-boundary requirement staying exactly
// where the consumer sits. The desktop adapter implements the same hooks
// over the TanStack hash router.
//
// Rules: an adapter instance must be render-constant (hook members are called
// as React hooks through it), and hook members follow the Rules of Hooks at
// every call site. This file is framework-free — it names hook-shaped function
// members but imports nothing.

/** Dynamic route params of the currently matched route (mirrors Next's shape). */
export type RouteParams = Record<string, string | string[]>;

/**
 * Read-only query-string view. Structural subset of URLSearchParams — exactly
 * the methods the measured call sites use (get/getAll + toString for the
 * pageview URL) plus `has` for completeness. Next's ReadonlyURLSearchParams
 * and a plain URLSearchParams both satisfy it; mutation is deliberately not
 * part of the contract (filter writes go through push/replace with a full
 * href, as /notes does today).
 */
export interface AppSearchParams {
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
  toString(): string;
}

/**
 * Imperative navigation. `back()` is carried for the port's completeness
 * (both routers support it; census shows zero current call sites). Next's
 * `redirect()` is NOT modeled: its one use is the web-only root page
 * (`app/page.tsx` → /home), which stays native Next.
 */
export interface NavigationActions {
  push(href: string): void;
  replace(href: string): void;
  back(): void;
}

export interface NavigationPort {
  /** Stable-identity actions object (web: next/navigation useRouter). */
  useNavigation(): NavigationActions;
  /**
   * Reactive pathname. Identity MUST change on path change only — never on a
   * query-only change (the shell's route-transition animation keys on it).
   */
  usePathname(): string;
  /**
   * Reactive search params. On web this keeps Next's requirement that
   * consumers of statically prerendered routes sit under a Suspense boundary —
   * that convention lives in the web shell, not in this contract.
   */
  useSearchParams(): AppSearchParams;
  /** Dynamic segment params of the matched route. */
  useParams<T extends RouteParams = RouteParams>(): T;
}

/**
 * Navigation-relevant props of the shared <AppLink> component. This is the
 * CONTRACT only — app-contracts is React-free, so the component itself lands
 * in @prismical/app-ui and renders the platform link the ports
 * provider supplies (web: next/link — preserving its prefetch behavior;
 * desktop: the TanStack router link). Anchor-level props (className, onClick,
 * target, …) ride on the component layer's own React typing, not here.
 * Census: the 37 current <Link> usages pass nothing beyond `href` + anchor
 * props; `replace` is included because both platform links support it and the
 * port exposes replace() imperatively.
 */
export interface AppLinkProps {
  href: string;
  replace?: boolean;
}
