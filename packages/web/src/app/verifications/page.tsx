import type { Metadata } from "next";
import { VerificationDashboard } from "@/components/VerificationDashboard";
import {
  getVerificationPageData,
  getVerificationProjectName,
  resolveVerificationProjectFilter,
} from "@/lib/verification-page-data";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const filter = resolveVerificationProjectFilter(searchParams.project);
  const projectName = getVerificationProjectName(filter);
  return { title: { absolute: `ao | ${projectName} Verification` } };
}

export default async function VerificationRoute(props: {
  searchParams: Promise<{ project?: string }>;
}) {
  const searchParams = await props.searchParams;
  const filter = resolveVerificationProjectFilter(searchParams.project);
  const data = await getVerificationPageData(filter);

  return (
    <VerificationDashboard
      leaderboard={data.leaderboard}
      recent={data.recent}
      projectName={data.projectName}
      selectedProjectId={data.selectedProjectId}
      loadError={data.loadError}
    />
  );
}
