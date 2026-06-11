import { create } from 'zustand'
import { api } from '../lib/api'

const CURRENT_PROJECT_KEY = 'creare_current_project_id'

interface Project {
  id: string
  name: string
  description: string | null
  ownerId: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

interface ProjectsState {
  projects: Project[]
  archived: Project[]
  currentProject: Project | null
  isLoading: boolean
  archivedLoading: boolean
  error: string | null
  load: () => Promise<void>
  loadArchived: () => Promise<void>
  setCurrentProject: (project: Project) => void
  createProject: (name: string, description?: string, templateId?: string) => Promise<Project>
  renameProject: (id: string, patch: { name?: string; description?: string }) => Promise<Project>
  archiveProject: (id: string) => Promise<void>
  unarchiveProject: (id: string) => Promise<void>
}

function recencyOf(project: Project): number {
  return Date.parse(project.updatedAt ?? project.createdAt)
}

function sortByRecency(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => recencyOf(b) - recencyOf(a))
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

export const useProjectStore = create<ProjectsState>((set, get) => ({
  projects: [],
  archived: [],
  currentProject: null,
  isLoading: false,
  archivedLoading: false,
  error: null,

  load: async () => {
    set({ isLoading: true, error: null })
    try {
      const fetched = await api.get<Project[]>('/projects')
      const projects = sortByRecency(fetched)
      const savedId = localStorage.getItem(CURRENT_PROJECT_KEY)
      const current =
        projects.find((p) => p.id === savedId) ?? projects[0] ?? null
      set({ projects, currentProject: current, isLoading: false, error: null })
    } catch (err) {
      set({ isLoading: false, error: errorMessage(err, 'Failed to load projects') })
    }
  },

  loadArchived: async () => {
    set({ archivedLoading: true })
    try {
      const archived = await api.get<Project[]>('/projects?archived=1')
      set({ archived, archivedLoading: false })
    } catch (err) {
      set({
        archivedLoading: false,
        error: errorMessage(err, 'Failed to load archived projects'),
      })
    }
  },

  setCurrentProject: (project) => {
    localStorage.setItem(CURRENT_PROJECT_KEY, project.id)
    set({ currentProject: project })
  },

  createProject: async (name, description, templateId) => {
    const project = await api.post<Project>('/projects', {
      name,
      ...(description !== undefined ? { description } : {}),
      ...(templateId !== undefined ? { templateId } : {}),
    })
    set((s) => ({ projects: [project, ...s.projects] }))
    get().setCurrentProject(project)
    return project
  },

  renameProject: async (id, patch) => {
    const updated = await api.patch<Project>(`/projects/${id}`, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
    })
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? updated : p)),
      currentProject: s.currentProject?.id === id ? updated : s.currentProject,
    }))
    return updated
  },

  archiveProject: async (id) => {
    await api.delete(`/projects/${id}`)
    set((s) => {
      const archivedProject = s.projects.find((p) => p.id === id)
      const projects = s.projects.filter((p) => p.id !== id)
      const archived = archivedProject ? [archivedProject, ...s.archived] : s.archived
      const currentProject =
        s.currentProject?.id === id ? (projects[0] ?? null) : s.currentProject
      if (currentProject) localStorage.setItem(CURRENT_PROJECT_KEY, currentProject.id)
      return { projects, archived, currentProject }
    })
  },

  unarchiveProject: async (id) => {
    const restored = await api.post<Project | undefined>(`/projects/${id}/restore`, {})
    set((s) => {
      const fallback = s.archived.find((p) => p.id === id)
      const project =
        restored ?? (fallback ? { ...fallback, archivedAt: null } : undefined)
      return {
        archived: s.archived.filter((p) => p.id !== id),
        projects: project ? [project, ...s.projects] : s.projects,
      }
    })
  },
}))
