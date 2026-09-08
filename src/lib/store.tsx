"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  agents as agentApi,
  orgs as orgApi,
  projects as projectApi,
  runs as runApi,
  settings as settingsApi,
  terminal as terminalApi,
} from "./ipc";
import {
  DEFAULT_NOTIFICATIONS,
  NOTIFICATIONS_KEY,
  parseNotifications,
  saveNotifications,
  type NotificationConfig,
} from "./notify";
import { retheme } from "./terminals";
import { DEFAULT_THEME, THEME_KEY, applyTheme, parseTheme, type Theme } from "./theme";
import type { Agent, Organization, Project } from "./types";

export type View = "board" | "terminal" | "settings";

const SELECTION_KEY = "agent-board.selection";

interface Selection {
  orgId: string | null;
  projectId: string | null;
}

interface Store {
  orgs: Organization[];
  theme: Theme;
  setTheme: (theme: Theme) => void;
  notifications: NotificationConfig;
  setNotifications: (config: NotificationConfig) => void;
  agents: Agent[];
  projects: Project[];
  org: Organization | null;
  project: Project | null;
  view: View;
  loading: boolean;
  error: string | null;
  setView: (view: View) => void;
  selectOrg: (id: string | null) => void;
  selectProject: (id: string | null) => void;
  refresh: () => Promise<void>;
  run: <T>(action: () => Promise<T>) => Promise<T | null>;
}

const StoreContext = createContext<Store | null>(null);

function readSelection(): Selection {
  if (typeof window === "undefined") return { orgId: null, projectId: null };
  try {
    return { orgId: null, projectId: null, ...JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "{}") };
  } catch {
    return { orgId: null, projectId: null };
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [notifications, setNotificationsState] =
    useState<NotificationConfig>(DEFAULT_NOTIFICATIONS);
  const [selection, setSelection] = useState<Selection>({ orgId: null, projectId: null });
  const [view, setView] = useState<View>("board");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextOrgs, nextProjects, nextAgents, stored] = await Promise.all([
        orgApi.list(),
        projectApi.list(),
        agentApi.list(),
        settingsApi.all(),
      ]);
      setOrgs(nextOrgs);
      setProjects(nextProjects);
      setAgents(nextAgents);
      applyTheme(parseTheme(stored[THEME_KEY]));
      setThemeState(parseTheme(stored[THEME_KEY]));
      setNotificationsState(parseNotifications(stored[NOTIFICATIONS_KEY]));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSelection(readSelection());
    void refresh();
  }, [refresh]);

  // A reload leaves this window with no sessions while their ptys keep running:
  // an agent nobody can see, and a run nothing can finish. Stop those and close
  // the runs out, once, before anything else claims a card.
  useEffect(() => {
    void (async () => {
      const orphans = await terminalApi.sessions().catch(() => []);
      await Promise.all(orphans.map((id) => terminalApi.kill(id).catch(() => undefined)));
      await runApi.reconcile().catch(() => undefined);
      await refresh();
    })();
    // Deliberately once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
  }, [selection]);

  // A selection can outlive the row it points at (deleted here or in another
  // window), so resolve against the loaded data and fall back to the first row.
  const org = useMemo(
    () => orgs.find((o) => o.id === selection.orgId) ?? orgs[0] ?? null,
    [orgs, selection.orgId],
  );
  const visibleProjects = useMemo(
    () => (org ? projects.filter((p) => p.orgId === org.id) : []),
    [projects, org],
  );
  const project = useMemo(
    () => visibleProjects.find((p) => p.id === selection.projectId) ?? visibleProjects[0] ?? null,
    [visibleProjects, selection.projectId],
  );

  // Paint first, persist after: a theme change should never wait on a write.
  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
    retheme();
    void settingsApi.set(THEME_KEY, JSON.stringify(next)).catch(() => undefined);
  }, []);

  const setNotifications = useCallback((next: NotificationConfig) => {
    setNotificationsState(next);
    void saveNotifications(next).catch(() => undefined);
  }, []);

  // Choosing a project is a request to look at its board. Staying on whatever
  // view happened to be open showed the last project's terminal instead.
  const selectOrg = useCallback((orgId: string | null) => {
    setSelection({ orgId, projectId: null });
    setView("board");
  }, []);

  const selectProject = useCallback((projectId: string | null) => {
    setSelection((current) => ({ ...current, projectId }));
    setView("board");
  }, []);

  // Wraps a mutation: surfaces the failure instead of throwing into React, and
  // reloads so the UI never drifts from what the database actually holds.
  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | null> => {
      try {
        const result = await action();
        setError(null);
        await refresh();
        return result;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    },
    [refresh],
  );

  const value = useMemo<Store>(
    () => ({
      orgs,
      agents,
      theme,
      setTheme,
      notifications,
      setNotifications,
      projects: visibleProjects,
      org,
      project,
      view,
      loading,
      error,
      setView,
      selectOrg,
      selectProject,
      refresh,
      run,
    }),
    [
      orgs,
      agents,
      theme,
      setTheme,
      notifications,
      setNotifications,
      visibleProjects,
      org,
      project,
      view,
      loading,
      error,
      selectOrg,
      selectProject,
      refresh,
      run,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside <StoreProvider>");
  return store;
}
