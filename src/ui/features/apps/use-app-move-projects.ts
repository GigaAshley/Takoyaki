// project-scoped apps: the projects an app on `hostId` can be moved into —
// every live project on that machine, in sidebar tree order with its depth
// (sub-projects indent under their parent in the Move to list).

import { useMemo } from "react";
import { useProjects } from "@/state/conversation-store";
import { orderProjectsAsTree } from "@/state/project-tree";

export interface AppMoveProject {
  slug: string;
  displayName: string;
  depth: number;
}

export function useAppMoveProjects(hostId: string | number): readonly AppMoveProject[] {
  const projects = useProjects();
  const host = String(hostId);
  return useMemo(
    () =>
      orderProjectsAsTree(projects.filter((p) => p.hostId === host && !p.archived)).map(({ project, depth }) => ({
        slug: project.slug,
        displayName: project.displayName,
        depth,
      })),
    [projects, host],
  );
}
