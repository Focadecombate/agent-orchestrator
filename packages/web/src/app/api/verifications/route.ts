import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import {
  getVerificationPageData,
  resolveVerificationProjectFilter,
} from "@/lib/verification-page-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/verifications — verification-gate eval data: per-agent pass-rate
 * leaderboard + recent verdicts, optionally scoped via ?project=<id>|all.
 */
export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const { searchParams } = new URL(request.url);
  const filter = resolveVerificationProjectFilter(searchParams.get("project") ?? undefined);
  const data = await getVerificationPageData(filter);

  return jsonWithCorrelation(
    {
      leaderboard: data.leaderboard,
      recent: data.recent,
      projectName: data.projectName,
      selectedProjectId: data.selectedProjectId,
      ...(data.loadError ? { error: data.loadError } : {}),
    },
    { status: data.loadError ? 500 : 200 },
    correlationId,
  );
}
