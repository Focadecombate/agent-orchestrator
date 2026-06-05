"use client";

import { useCallback, useState } from "react";
import type { AgentVerificationStats, VerificationRecord } from "@aoagents/ao-core";

interface VerificationDashboardProps {
  leaderboard: AgentVerificationStats[];
  recent: VerificationRecord[];
  projectName: string;
  /** null = all projects */
  selectedProjectId: string | null;
  loadError?: string;
}

const TH =
  "px-3 py-2 text-left text-[10.5px] font-mono font-500 uppercase tracking-[0.05em] text-[var(--color-text-muted)]";
const TD = "px-3 py-2 text-[12px] text-[var(--color-text-secondary)] align-top";

const VERDICT_BADGE: Record<VerificationRecord["verdict"], string> = {
  pass: "text-[var(--color-ci-pass)] border-[var(--color-ci-pass)]",
  blocked: "text-[var(--color-status-error)] border-[var(--color-status-error)]",
  pending: "text-[var(--color-status-pending)] border-[var(--color-status-pending)]",
};

/** Deterministic UTC formatting so server and client render identically (no hydration drift). */
function formatTimestamp(tsEpoch: number): string {
  const iso = new Date(tsEpoch).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function VerdictBadge({ verdict }: { verdict: VerificationRecord["verdict"] }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.05em] ${VERDICT_BADGE[verdict]}`}
    >
      {verdict}
    </span>
  );
}

export function VerificationDashboard({
  leaderboard: initialLeaderboard,
  recent: initialRecent,
  projectName,
  selectedProjectId,
  loadError,
}: VerificationDashboardProps) {
  const [leaderboard, setLeaderboard] = useState(initialLeaderboard);
  const [recent, setRecent] = useState(initialRecent);
  const [error, setError] = useState<string | undefined>(loadError);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const projectParam = selectedProjectId ?? "all";
      const res = await fetch(`/api/verifications?project=${encodeURIComponent(projectParam)}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as {
        leaderboard?: AgentVerificationStats[];
        recent?: VerificationRecord[];
        error?: string;
      };
      if (!res.ok || data.error) {
        setError(data.error ?? `Failed to refresh (${res.status})`);
        return;
      }
      setLeaderboard(data.leaderboard ?? []);
      setRecent(data.recent ?? []);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh verification data.");
    } finally {
      setRefreshing(false);
    }
  }, [selectedProjectId]);

  return (
    <div className="h-screen overflow-y-auto bg-[var(--color-bg-base)] text-[var(--color-text-primary)]">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-6 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-[15px] font-600">Verification</h1>
          <span className="text-[12px] text-[var(--color-text-muted)]">{projectName}</span>
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="rounded-[6px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated-hover)] disabled:opacity-50"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </header>

        {error ? (
          <div className="rounded-[7px] border border-[var(--color-alert-changes)] bg-[var(--color-alert-changes-bg)] px-3 py-2 text-[12px] text-[var(--color-alert-changes)]">
            {error}
          </div>
        ) : null}

        <section className="flex flex-col gap-2">
          <h2 className="text-[11px] font-mono font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
            Agent leaderboard
          </h2>
          <div className="overflow-hidden rounded-[7px] border border-[var(--color-border-subtle)]">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)]">
                  <th className={TH}>Agent</th>
                  <th className={TH}>Runs</th>
                  <th className={TH}>Pass</th>
                  <th className={TH}>Blocked</th>
                  <th className={TH}>Pending</th>
                  <th className={TH}>Pass rate</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.length > 0 ? (
                  leaderboard.map((row) => (
                    <tr
                      key={row.agent}
                      className="border-b border-[var(--color-border-subtle)] last:border-b-0"
                    >
                      <td className={`${TD} font-mono text-[var(--color-text-primary)]`}>
                        {row.agent}
                      </td>
                      <td className={TD}>{row.total}</td>
                      <td className={`${TD} text-[var(--color-ci-pass)]`}>{row.passed}</td>
                      <td className={`${TD} text-[var(--color-status-error)]`}>{row.blocked}</td>
                      <td className={`${TD} text-[var(--color-status-pending)]`}>{row.pending}</td>
                      <td className={`${TD} font-mono text-[var(--color-text-primary)]`}>
                        {formatPercent(row.passRate)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-6 text-[12px] text-[var(--color-text-secondary)]"
                    >
                      No verdicts recorded yet. Enable the gate with a <code>review.url</code> backend.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-[11px] font-mono font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
            Recent verdicts
          </h2>
          <div className="overflow-hidden rounded-[7px] border border-[var(--color-border-subtle)]">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)]">
                  <th className={TH}>Time</th>
                  <th className={TH}>Session</th>
                  <th className={TH}>PR</th>
                  <th className={TH}>Agent</th>
                  <th className={TH}>Verifier</th>
                  <th className={TH}>Verdict</th>
                  <th className={TH}>Findings</th>
                </tr>
              </thead>
              <tbody>
                {recent.length > 0 ? (
                  recent.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-[var(--color-border-subtle)] last:border-b-0"
                    >
                      <td className={`${TD} whitespace-nowrap font-mono`}>
                        {formatTimestamp(row.tsEpoch)}
                      </td>
                      <td className={`${TD} font-mono`}>{row.sessionId}</td>
                      <td className={TD}>{row.prNumber ? `#${row.prNumber}` : "—"}</td>
                      <td className={`${TD} font-mono`}>{row.agent ?? "—"}</td>
                      <td className={`${TD} font-mono`}>{row.verifier ?? "—"}</td>
                      <td className={TD}>
                        <VerdictBadge verdict={row.verdict} />
                      </td>
                      <td className={`${TD} font-mono`}>
                        <span className="text-[var(--color-status-error)]">{row.errorCount}e</span>{" "}
                        <span className="text-[var(--color-status-pending)]">
                          {row.warningCount}w
                        </span>{" "}
                        <span className="text-[var(--color-text-muted)]">{row.infoCount}i</span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-6 text-[12px] text-[var(--color-text-secondary)]"
                    >
                      No verdicts recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
