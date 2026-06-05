import "server-only";

import {
  getAgentVerificationStats,
  listVerifications,
  type AgentVerificationStats,
  type VerificationRecord,
} from "@aoagents/ao-core";
import {
  getAllProjects,
  getPrimaryProjectId,
  getProjectName,
  type ProjectInfo,
} from "@/lib/project-name";

const RECENT_VERDICT_LIMIT = 50;

export interface VerificationPageData {
  leaderboard: AgentVerificationStats[];
  recent: VerificationRecord[];
  projectName: string;
  projects: ProjectInfo[];
  /** null = all projects */
  selectedProjectId: string | null;
  loadError?: string;
}

export function resolveVerificationProjectFilter(project?: string): string {
  if (project === "all") return "all";
  const projects = getAllProjects();
  if (project && projects.some((entry) => entry.id === project)) {
    return project;
  }
  return getPrimaryProjectId();
}

export function getVerificationProjectName(projectFilter: string | undefined): string {
  if (projectFilter === "all") return "All Projects";
  const projects = getAllProjects();
  if (projectFilter) {
    const selected = projects.find((entry) => entry.id === projectFilter);
    if (selected) return selected.name;
  }
  return getProjectName();
}

export async function getVerificationPageData(project?: string): Promise<VerificationPageData> {
  const filter = resolveVerificationProjectFilter(project);
  const projectId = filter === "all" ? undefined : filter;
  const projects = getAllProjects();
  const base = {
    projectName: getVerificationProjectName(filter),
    projects,
    selectedProjectId: projectId ?? null,
  };

  try {
    const leaderboard = [...getAgentVerificationStats(projectId)].sort(
      (a, b) => b.passRate - a.passRate || b.total - a.total,
    );
    const recent = listVerifications({ projectId, limit: RECENT_VERDICT_LIMIT });
    return { ...base, leaderboard, recent };
  } catch (err) {
    const loadError =
      err instanceof Error && err.message.trim()
        ? (err.message.split(/\r?\n/)[0]?.trim() ?? "Failed to load verification data.")
        : "Failed to load verification data.";
    return { ...base, leaderboard: [], recent: [], loadError };
  }
}
