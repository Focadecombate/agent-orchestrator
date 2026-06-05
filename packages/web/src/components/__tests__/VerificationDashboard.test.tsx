import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentVerificationStats, VerificationRecord } from "@aoagents/ao-core";
import { VerificationDashboard } from "../VerificationDashboard";

const leaderboard: AgentVerificationStats[] = [
  { agent: "claude-code", total: 4, passed: 3, blocked: 1, pending: 0, passRate: 0.75 },
  { agent: "codex", total: 2, passed: 0, blocked: 2, pending: 0, passRate: 0 },
];

const recent: VerificationRecord[] = [
  {
    id: 2,
    tsEpoch: Date.UTC(2026, 5, 4, 20, 31),
    projectId: "app",
    sessionId: "app-2",
    prNumber: 8,
    agent: "claude-code",
    verifier: "http:localhost:8088",
    verdict: "pass",
    errorCount: 0,
    warningCount: 1,
    infoCount: 2,
    lensVotes: null,
    attempt: 1,
    durationMs: 1200,
    targetSha: null,
    baseSha: null,
  },
  {
    id: 1,
    tsEpoch: Date.UTC(2026, 5, 4, 20, 30),
    projectId: "app",
    sessionId: "app-1",
    prNumber: 7,
    agent: "codex",
    verifier: "codex",
    verdict: "blocked",
    errorCount: 2,
    warningCount: 0,
    infoCount: 0,
    lensVotes: null,
    attempt: 1,
    durationMs: 900,
    targetSha: null,
    baseSha: null,
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VerificationDashboard", () => {
  it("renders the agent leaderboard with pass rates", () => {
    render(
      <VerificationDashboard
        leaderboard={leaderboard}
        recent={recent}
        projectName="App"
        selectedProjectId="app"
      />,
    );

    expect(screen.getAllByText("claude-code").length).toBeGreaterThan(0);
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("renders recent verdicts with verdict badges and a deterministic timestamp", () => {
    render(
      <VerificationDashboard
        leaderboard={leaderboard}
        recent={recent}
        projectName="App"
        selectedProjectId="app"
      />,
    );

    expect(screen.getByText("pass")).toBeInTheDocument();
    expect(screen.getByText("blocked")).toBeInTheDocument();
    expect(screen.getByText("#8")).toBeInTheDocument();
    expect(screen.getByText("2026-06-04 20:31")).toBeInTheDocument();
  });

  it("shows an empty state when there are no verdicts", () => {
    render(
      <VerificationDashboard
        leaderboard={[]}
        recent={[]}
        projectName="App"
        selectedProjectId={null}
      />,
    );

    expect(screen.getAllByText(/No verdicts recorded yet/i).length).toBeGreaterThan(0);
  });

  it("surfaces a load error", () => {
    render(
      <VerificationDashboard
        leaderboard={[]}
        recent={[]}
        projectName="App"
        selectedProjectId="app"
        loadError="better-sqlite3 unavailable"
      />,
    );

    expect(screen.getByText("better-sqlite3 unavailable")).toBeInTheDocument();
  });

  it("refreshes from the API scoped to the selected project", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        leaderboard: [
          { agent: "kimicode", total: 1, passed: 1, blocked: 0, pending: 0, passRate: 1 },
        ],
        recent: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <VerificationDashboard
        leaderboard={leaderboard}
        recent={recent}
        projectName="App"
        selectedProjectId="app"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(screen.getByText("kimicode")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/verifications?project=app",
      expect.objectContaining({ cache: "no-store" }),
    );
  });
});
