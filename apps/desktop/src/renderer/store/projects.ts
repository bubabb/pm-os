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
  currentProject: Project | null
  isLoading: boolean
  load: () => Promise<void>
  setCurrentProject: (project: Project) => void
  createProject: (name: string, description?: string) => Promise<Project>
  archiveProject: (id: string) => Promise<void>
}

export const useProjectStore = create<ProjectsState>((set, get) => ({
  projects: [],
  currentProject: null,
  isLoading: false,

  load: async () => {
    set({ isLoading: true })
    const projects = await api.get<Project[]>('/projects')
    const savedId = localStorage.getItem(CURRENT_PROJECT_KEY)
    const current =
      projects.find((p) => p.id === savedId) ?? projects[0] ?? null
    set({ projects, currentProject: current, isLoading: false })
  },

  setCurrentProject: (project) => {
    localStorage.setItem(CURRENT_PROJECT_KEY, project.id)
    set({ currentProject: project })
  },

  createProject: async (name, description) => {
    const project = await api.post<Project>('/projects', { name, description })
    set((s) => ({ projects: [...s.projects, project] }))
    if (!get().currentProject) {
      get().setCurrentProject(project)
    }
    return project
  },

  archiveProject: async (id) => {
    await api.delete(`/projects/${id}`)
    set((s) => {
      const projects = s.projects.filter((p) => p.id !== id)
      const currentProject =
        s.currentProject?.id === id ? (projects[0] ?? null) : s.currentProject
      if (currentProject) localStorage.setItem(CURRENT_PROJECT_KEY, currentProject.id)
      return { projects, currentProject }
    })
  },
}))
