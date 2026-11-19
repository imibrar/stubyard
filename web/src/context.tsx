import { createContext, useContext, type ReactNode } from 'react';
import type { Overview, Project, SystemInfo } from './api';
import { registerProjectSlugs, useDebounced, useFetch, useHubEvents } from './hooks';

interface ProjectsState {
  projects: Project[] | null;
  error: string | null;
  reload: () => void;
  system: SystemInfo | null;
  connected: boolean;
}

const ProjectsCtx = createContext<ProjectsState>({ projects: null, error: null, reload: () => undefined, system: null, connected: false });
export const useProjects = () => useContext(ProjectsCtx);

/** Global state: the project list, system info and the live-connection flag. */
export function ProjectsProvider({ children }: { children: ReactNode }) {
  const projects = useFetch<Project[]>('/api/projects');
  registerProjectSlugs(projects.data);
  const system = useFetch<SystemInfo>('/api/system');
  const reload = useDebounced(() => void projects.reload(), 300);
  const connected = useHubEvents(null, (e) => {
    if (e.type.startsWith('project.') || e.type === 'message.created' || e.type === 'message.updated' || e.type === 'user.changed') reload();
  });
  return (
    <ProjectsCtx.Provider value={{ projects: projects.data, error: projects.error, reload: projects.reload, system: system.data, connected }}>
      {children}
    </ProjectsCtx.Provider>
  );
}

export interface ProjectState {
  slug: string;
  overview: Overview;
  reload: () => void;
}

const ProjectCtx = createContext<ProjectState | null>(null);
export const ProjectProvider = ProjectCtx.Provider;
/** The current project (inside /p/:slug), or null on global pages. */
export const useProjectMaybe = () => useContext(ProjectCtx);
export function useProject(): ProjectState {
  const p = useContext(ProjectCtx);
  if (!p) throw new Error('useProject outside a project');
  return p;
}
