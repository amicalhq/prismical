import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

type SettingsHeaderActionsContextValue = {
  actions: ReactNode | null;
  setActions: (actions: ReactNode | null) => void;
  headerContent: ReactNode | null;
  setHeaderContent: (content: ReactNode | null) => void;
  isScrolled: boolean;
  setIsScrolled: (scrolled: boolean) => void;
};

const SettingsHeaderActionsContext =
  createContext<SettingsHeaderActionsContextValue | null>(null);

export function SettingsHeaderProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<ReactNode | null>(null);
  const [headerContent, setHeaderContent] = useState<ReactNode | null>(null);
  const [isScrolled, setIsScrolled] = useState(false);

  const value = useMemo(
    () => ({
      actions,
      setActions,
      headerContent,
      setHeaderContent,
      isScrolled,
      setIsScrolled,
    }),
    [actions, headerContent, isScrolled],
  );

  return (
    <SettingsHeaderActionsContext.Provider value={value}>
      {children}
    </SettingsHeaderActionsContext.Provider>
  );
}

export function useSettingsHeaderActions(): SettingsHeaderActionsContextValue {
  const context = useContext(SettingsHeaderActionsContext);
  if (!context) {
    throw new Error(
      "useSettingsHeaderActions must be used within SettingsHeaderProvider",
    );
  }

  return context;
}

