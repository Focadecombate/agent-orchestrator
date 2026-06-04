import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PathsModule from "../paths.js";

// Redirect the AO base dir to an isolated temp dir so the real
// ~/.agent-orchestrator/verifications.db is never touched.
const hoisted = vi.hoisted(() => ({ baseDir: "" }));
vi.mock("../paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PathsModule>();
  return { ...actual, getAoBaseDir: () => hoisted.baseDir };
});

import {
  closeVerificationDb,
  getAgentVerificationStats,
  getLatestVerification,
  isVerificationDbAvailable,
  listVerifications,
  recordVerification,
} from "../verification-db.js";

describe("verification-db", () => {
  beforeEach(() => {
    hoisted.baseDir = mkdtempSync(join(tmpdir(), "ao-verif-"));
    closeVerificationDb();
  });

  afterEach(() => {
    closeVerificationDb();
    rmSync(hoisted.baseDir, { recursive: true, force: true });
  });

  it("is backed by a live database in this environment", () => {
    expect(isVerificationDbAvailable()).toBe(true);
  });

  it("round-trips a verdict including lens votes", () => {
    const recorded = recordVerification(
      {
        projectId: "proj",
        sessionId: "sess-1",
        prNumber: 42,
        agent: "claude-code",
        verifier: "http://localhost:8000",
        verdict: "blocked",
        errorCount: 2,
        warningCount: 1,
        lensVotes: { correctness: "pass", security: "fail" },
        attempt: 3,
        durationMs: 1234,
        targetSha: "deadbeef",
        baseSha: "cafebabe",
      },
      1_000,
    );

    expect(recorded?.id).toBeGreaterThan(0);

    const latest = getLatestVerification("sess-1");
    expect(latest).toMatchObject({
      sessionId: "sess-1",
      prNumber: 42,
      agent: "claude-code",
      verifier: "http://localhost:8000",
      verdict: "blocked",
      errorCount: 2,
      warningCount: 1,
      lensVotes: { correctness: "pass", security: "fail" },
      attempt: 3,
      durationMs: 1234,
      targetSha: "deadbeef",
      baseSha: "cafebabe",
    });
  });

  it("returns the newest verdict for a session", () => {
    recordVerification({ sessionId: "sess-1", verdict: "blocked" }, 1_000);
    recordVerification({ sessionId: "sess-1", verdict: "pass" }, 2_000);

    expect(getLatestVerification("sess-1")?.verdict).toBe("pass");
  });

  it("returns null for an unknown session", () => {
    expect(getLatestVerification("nope")).toBeNull();
  });

  it("filters history by agent and verdict, newest first", () => {
    recordVerification({ sessionId: "a", agent: "codex", verdict: "pass" }, 1_000);
    recordVerification({ sessionId: "b", agent: "claude-code", verdict: "blocked" }, 2_000);
    recordVerification({ sessionId: "c", agent: "claude-code", verdict: "pass" }, 3_000);

    const claudePasses = listVerifications({ agent: "claude-code", verdict: "pass" });
    expect(claudePasses).toHaveLength(1);
    expect(claudePasses[0]?.sessionId).toBe("c");

    const allClaude = listVerifications({ agent: "claude-code" });
    expect(allClaude.map((r) => r.sessionId)).toEqual(["c", "b"]);
  });

  it("computes per-agent pass rates excluding pending from the denominator", () => {
    recordVerification({ sessionId: "1", agent: "claude-code", verdict: "pass" }, 1_000);
    recordVerification({ sessionId: "2", agent: "claude-code", verdict: "pass" }, 2_000);
    recordVerification({ sessionId: "3", agent: "claude-code", verdict: "blocked" }, 3_000);
    recordVerification({ sessionId: "4", agent: "claude-code", verdict: "pending" }, 4_000);
    recordVerification({ sessionId: "5", agent: "codex", verdict: "blocked" }, 5_000);

    const stats = getAgentVerificationStats();
    const claude = stats.find((s) => s.agent === "claude-code");
    const codex = stats.find((s) => s.agent === "codex");

    expect(claude).toMatchObject({ total: 4, passed: 2, blocked: 1, pending: 1 });
    expect(claude?.passRate).toBeCloseTo(2 / 3);
    expect(codex).toMatchObject({ total: 1, passed: 0, blocked: 1, passRate: 0 });
  });
});
