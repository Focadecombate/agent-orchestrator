import { describe, it, expect } from "vitest";
import {
  createDetectingDecision,
  hashEvidence,
  isDetectingTimedOut,
  resolvePRLiveDecision,
  DETECTING_MAX_ATTEMPTS,
  DETECTING_MAX_DURATION_MS,
} from "../lifecycle-status-decisions.js";

const MERGEABLE_OPEN_PR = {
  prState: "open" as const,
  ciStatus: "passing" as const,
  reviewDecision: "none" as const,
  mergeable: true,
  shouldEscalateIdleToStuck: false,
  idleWasBlocked: false,
  activityEvidence: "",
};

describe("hashEvidence", () => {
  it("returns a 12-character hex string", () => {
    const hash = hashEvidence("some evidence string");
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  it("returns the same hash for the same input", () => {
    const hash1 = hashEvidence("test evidence");
    const hash2 = hashEvidence("test evidence");
    expect(hash1).toBe(hash2);
  });

  it("returns different hashes for different inputs", () => {
    const hash1 = hashEvidence("evidence A");
    const hash2 = hashEvidence("evidence B");
    expect(hash1).not.toBe(hash2);
  });

  it("ignores activity labels and timestamps when hashing probe evidence", () => {
    const active = hashEvidence(
      "signal_disagreement runtime=alive process=unknown activity_signal=valid via_native activity=active at=2026-04-18T10:00:00.000Z",
    );
    const blocked = hashEvidence(
      "signal_disagreement runtime=alive process=unknown activity_signal=valid via_native activity=blocked at=2026-04-18T10:01:00.000Z",
    );

    expect(active).toBe(blocked);
  });
});

describe("isDetectingTimedOut", () => {
  it("returns false when detectingStartedAt is undefined", () => {
    expect(isDetectingTimedOut(undefined)).toBe(false);
  });

  it("returns false when detectingStartedAt is invalid", () => {
    expect(isDetectingTimedOut("invalid-date")).toBe(false);
  });

  it("returns false when within time budget", () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 60_000).toISOString(); // 1 minute ago
    expect(isDetectingTimedOut(startedAt, now)).toBe(false);
  });

  it("returns true when time budget exceeded", () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - DETECTING_MAX_DURATION_MS - 1000).toISOString();
    expect(isDetectingTimedOut(startedAt, now)).toBe(true);
  });

  it("returns false at exactly the time limit", () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - DETECTING_MAX_DURATION_MS).toISOString();
    expect(isDetectingTimedOut(startedAt, now)).toBe(false);
  });
});

describe("createDetectingDecision", () => {
  const baseInput = {
    currentAttempts: 0,
    idleWasBlocked: false,
    evidence: "test evidence",
  };

  describe("attempt counting", () => {
    it("increments attempts when no previous evidence hash exists", () => {
      const result = createDetectingDecision({
        ...baseInput,
        currentAttempts: 1,
      });
      expect(result.detecting.attempts).toBe(2);
      expect(result.status).toBe("detecting");
    });

    it("increments attempts when evidence is unchanged", () => {
      const evidenceHash = hashEvidence("same evidence");
      const result = createDetectingDecision({
        ...baseInput,
        currentAttempts: 2,
        evidence: "same evidence",
        previousEvidenceHash: evidenceHash,
      });
      expect(result.detecting.attempts).toBe(3);
    });

    it("resets attempts to 1 when evidence changes", () => {
      const oldEvidenceHash = hashEvidence("old evidence");
      const result = createDetectingDecision({
        ...baseInput,
        currentAttempts: 5,
        evidence: "new evidence",
        previousEvidenceHash: oldEvidenceHash,
      });
      expect(result.detecting.attempts).toBe(1);
      expect(result.status).toBe("detecting");
    });
  });

  describe("attempt-based escalation", () => {
    it("escalates to stuck after exceeding max attempts", () => {
      const evidenceHash = hashEvidence("test evidence");
      const result = createDetectingDecision({
        ...baseInput,
        currentAttempts: DETECTING_MAX_ATTEMPTS,
        previousEvidenceHash: evidenceHash,
      });
      expect(result.status).toBe("stuck");
      expect(result.detecting.attempts).toBe(DETECTING_MAX_ATTEMPTS + 1);
      expect(result.sessionState).toBe("stuck");
      expect(result.sessionReason).toBe("probe_failure");
    });

    it("uses error_in_process reason when idleWasBlocked", () => {
      const evidenceHash = hashEvidence("test evidence");
      const result = createDetectingDecision({
        ...baseInput,
        currentAttempts: DETECTING_MAX_ATTEMPTS,
        idleWasBlocked: true,
        previousEvidenceHash: evidenceHash,
      });
      expect(result.status).toBe("stuck");
      expect(result.sessionReason).toBe("error_in_process");
    });
  });

  describe("time-based escalation", () => {
    it("escalates to stuck when time budget is exceeded", () => {
      const now = new Date();
      const oldStartedAt = new Date(now.getTime() - DETECTING_MAX_DURATION_MS - 1000).toISOString();
      const evidenceHash = hashEvidence("test evidence");

      const result = createDetectingDecision({
        ...baseInput,
        currentAttempts: 1, // Well under attempt limit
        detectingStartedAt: oldStartedAt,
        previousEvidenceHash: evidenceHash,
        now,
      });

      expect(result.status).toBe("stuck");
      expect(result.sessionState).toBe("stuck");
    });

    it("does not escalate when both time and attempts are within limits", () => {
      const now = new Date();
      const recentStartedAt = new Date(now.getTime() - 60_000).toISOString(); // 1 minute ago
      const evidenceHash = hashEvidence("test evidence");

      const result = createDetectingDecision({
        ...baseInput,
        currentAttempts: 1,
        detectingStartedAt: recentStartedAt,
        previousEvidenceHash: evidenceHash,
        now,
      });

      expect(result.status).toBe("detecting");
    });

    it("resets detectingStartedAt when evidence changes", () => {
      const now = new Date();
      const oldStartedAt = new Date(now.getTime() - DETECTING_MAX_DURATION_MS - 1000).toISOString();
      const oldEvidenceHash = hashEvidence("old evidence");

      const result = createDetectingDecision({
        ...baseInput,
        currentAttempts: 1,
        evidence: "new evidence", // Different from old
        detectingStartedAt: oldStartedAt,
        previousEvidenceHash: oldEvidenceHash,
        now,
      });

      // Should NOT escalate because evidence changed, resetting the timer
      expect(result.status).toBe("detecting");
      expect(result.detecting.attempts).toBe(1);
      expect(result.detecting.startedAt).not.toBe(oldStartedAt);
    });
  });

  describe("metadata tracking", () => {
    it("includes detectingEvidenceHash in the result", () => {
      const result = createDetectingDecision(baseInput);
      expect(result.detecting.evidenceHash).toBe(hashEvidence("test evidence"));
    });

    it("includes detectingStartedAt in the result", () => {
      const result = createDetectingDecision(baseInput);
      expect(result.detecting.startedAt).toBeDefined();
      expect(Date.parse(result.detecting.startedAt!)).not.toBeNaN();
    });

    it("preserves detectingStartedAt when evidence is unchanged", () => {
      const now = new Date();
      const previousStartedAt = new Date(now.getTime() - 30_000).toISOString();
      const evidenceHash = hashEvidence("test evidence");

      const result = createDetectingDecision({
        ...baseInput,
        detectingStartedAt: previousStartedAt,
        previousEvidenceHash: evidenceHash,
        now,
      });

      expect(result.detecting.startedAt).toBe(previousStartedAt);
    });
  });
});

describe("verification gate (resolveOpenPRDecision via resolvePRLiveDecision)", () => {
  it("reaches merge_ready when the gate is disabled (verification=none)", () => {
    const result = resolvePRLiveDecision({ ...MERGEABLE_OPEN_PR, verification: "none" });

    expect(result.status).toBe("mergeable");
    expect(result.prReason).toBe("merge_ready");
  });

  it("reaches merge_ready when verification passes", () => {
    const result = resolvePRLiveDecision({ ...MERGEABLE_OPEN_PR, verification: "pass" });

    expect(result.status).toBe("mergeable");
    expect(result.prReason).toBe("merge_ready");
  });

  it("withholds merge_ready and reports verifying while verification is pending", () => {
    const result = resolvePRLiveDecision({ ...MERGEABLE_OPEN_PR, verification: "pending" });

    expect(result.status).toBe("review_pending");
    expect(result.prReason).toBe("verifying");
    expect(result.sessionState).toBe("idle");
  });

  it("withholds merge_ready and requests changes when verification is blocked", () => {
    const result = resolvePRLiveDecision({ ...MERGEABLE_OPEN_PR, verification: "blocked" });

    expect(result.status).toBe("changes_requested");
    expect(result.prReason).toBe("verification_failed");
    expect(result.sessionState).toBe("working");
    expect(result.sessionReason).toBe("resolving_review_comments");
  });

  it("does not reach merge_ready for any non-pass verdict", () => {
    for (const verification of ["pending", "blocked"] as const) {
      const result = resolvePRLiveDecision({ ...MERGEABLE_OPEN_PR, verification });
      expect(result.prReason).not.toBe("merge_ready");
    }
  });
});
