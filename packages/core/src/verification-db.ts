/**
 * SQLite store for verification-gate verdicts.
 *
 * System of record for the merge verification funnel: one row per verdict, with
 * the agent that WROTE the code and the verifier that JUDGED it kept distinct so
 * the same table serves both consumers described in FORK-PLAN.md §3 —
 *   - gate: latest row for a session
 *   - eval: GROUP BYs over history (per-agent pass rates, pass@k, regression).
 *
 * Mirrors the proven `events-db.ts` lifecycle: lazy-initialized singleton, opens
 * on first call (never on import), WAL + busy_timeout for multi-process access,
 * and graceful degradation to a no-op when better-sqlite3 is unavailable (the
 * native binding is an optional dependency that may fail to build).
 */

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAoBaseDir } from "./paths.js";

// createRequire lets us try/catch the native module load without top-level await.
const _require = createRequire(import.meta.url);

type BetterSqlite3Database = {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): void;
  prepare(source: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
};

let _db: BetterSqlite3Database | null = null;
let _dbFailed = false;
let _dbUnavailableWarningEmitted = false;

/** Verdicts that are recorded. `none` (gate disabled) is never written — no row means no gate. */
export type VerificationVerdict = "pass" | "blocked" | "pending";

export interface VerificationRecordInput {
  projectId?: string;
  sessionId: string;
  /** Stable issue id, so a fresh attempt at the same issue can read prior verdicts. */
  issueId?: string;
  prNumber?: number;
  /** Which agent/model WROTE the code under review (the eval dimension). */
  agent?: string;
  /** Which backend JUDGED it (review.url host, adapter name, etc.). */
  verifier?: string;
  verdict: VerificationVerdict;
  errorCount?: number;
  warningCount?: number;
  infoCount?: number;
  /** Per-lens votes, e.g. { correctness: "pass", security: "fail" }. Stored as JSON. */
  lensVotes?: Record<string, string>;
  /** Human-readable "why blocked" summary, surfaced to the next attempt's prompt. */
  summary?: string;
  /** Retry counter for re-verification loops. */
  attempt?: number;
  durationMs?: number;
  targetSha?: string;
  baseSha?: string;
}

export interface VerificationRecord {
  id: number;
  tsEpoch: number;
  projectId: string | null;
  sessionId: string;
  issueId: string | null;
  prNumber: number | null;
  agent: string | null;
  verifier: string | null;
  verdict: VerificationVerdict;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  lensVotes: Record<string, string> | null;
  summary: string | null;
  attempt: number;
  durationMs: number | null;
  targetSha: string | null;
  baseSha: string | null;
}

export interface ListVerificationsFilter {
  sessionId?: string;
  projectId?: string;
  agent?: string;
  verdict?: VerificationVerdict;
  limit?: number;
}

/** One row per agent for the eval leaderboard. */
export interface AgentVerificationStats {
  agent: string;
  total: number;
  passed: number;
  blocked: number;
  pending: number;
  /** passed / (passed + blocked) — pending runs excluded from the denominator. */
  passRate: number;
}

function getVerificationDbPath(): string {
  return join(getAoBaseDir(), "verifications.db");
}

function initSchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verifications (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_epoch      INTEGER NOT NULL,
      project_id    TEXT,
      session_id    TEXT NOT NULL,
      issue_id      TEXT,
      pr_number     INTEGER,
      agent         TEXT,
      verifier      TEXT,
      verdict       TEXT NOT NULL,
      error_count   INTEGER DEFAULT 0,
      warning_count INTEGER DEFAULT 0,
      info_count    INTEGER DEFAULT 0,
      lens_votes    TEXT,
      summary       TEXT,
      attempt       INTEGER DEFAULT 1,
      duration_ms   INTEGER,
      target_sha    TEXT,
      base_sha      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_v_session ON verifications(session_id);
    CREATE INDEX IF NOT EXISTS idx_v_agent   ON verifications(agent);
    CREATE INDEX IF NOT EXISTS idx_v_project ON verifications(project_id);
  `);
}

/** Add a column to an existing table only when it is missing (idempotent migration). */
function ensureColumn(db: BetterSqlite3Database, name: string, type: string): void {
  const columns = (
    db.prepare(`PRAGMA table_info(verifications)`).all() as { name: string }[]
  ).map((column) => column.name);
  if (!columns.includes(name)) {
    db.exec(`ALTER TABLE verifications ADD COLUMN ${name} ${type}`);
  }
}

function openDb(): BetterSqlite3Database {
  const Database = _require("better-sqlite3") as new (path: string) => BetterSqlite3Database;
  mkdirSync(getAoBaseDir(), { recursive: true });
  const db = new Database(getVerificationDbPath());

  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");
  db.pragma("synchronous = NORMAL");

  const version = db.pragma("user_version", { simple: true }) as number;
  initSchema(db);
  // v2 added issue_id + summary (verifier "why blocked" memory). ALTER for DBs
  // created at v1; fresh DBs already have the columns from initSchema.
  ensureColumn(db, "issue_id", "TEXT");
  ensureColumn(db, "summary", "TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_v_issue ON verifications(issue_id)`);
  if (version < 2) {
    db.pragma("user_version = 2");
  }

  return db;
}

function isMissingBetterSqlite3Binding(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Could not locate the bindings file") ||
    message.includes("better_sqlite3.node") ||
    message.includes("Cannot find module 'better-sqlite3'")
  );
}

function firstErrorLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0] ?? "unknown error";
}

function emitVerificationDbUnavailableWarning(err: unknown): void {
  if (_dbUnavailableWarningEmitted) return;
  if (process.env["AO_DEBUG"] !== "1") return;
  _dbUnavailableWarningEmitted = true;
  const detail = isMissingBetterSqlite3Binding(err)
    ? `better-sqlite3 not compiled for Node ${process.version} (ABI v${process.versions.modules}). Run \`pnpm rebuild better-sqlite3\`.`
    : `better-sqlite3 failed to load: ${firstErrorLine(err)}`;
  // eslint-disable-next-line no-console
  console.warn(`[ao] verification store disabled: ${detail}`);
}

/**
 * Lazily-initialized DB connection. Returns null when better-sqlite3 is
 * unavailable — every caller treats null as "store disabled" (no-op writes,
 * empty reads), so the gate keeps working without the eval store.
 */
export function getVerificationDb(): BetterSqlite3Database | null {
  if (_dbFailed) return null;
  if (_db) return _db;
  try {
    _db = openDb();
    return _db;
  } catch (err) {
    _dbFailed = true;
    emitVerificationDbUnavailableWarning(err);
    return null;
  }
}

/** Whether the verification store is backed by a live database in this process. */
export function isVerificationDbAvailable(): boolean {
  return getVerificationDb() !== null;
}

/**
 * Close the cached connection and reset module state. Required on Windows before
 * removing the DB file (the SQLite handle holds an exclusive lock) and by tests
 * that recreate the AO base dir between runs.
 */
export function closeVerificationDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      // best-effort: connection may already be closed
    }
    _db = null;
  }
  _dbFailed = false;
  _dbUnavailableWarningEmitted = false;
}

function rowToRecord(row: Record<string, unknown>): VerificationRecord {
  const rawVotes = row["lens_votes"] as string | null;
  let lensVotes: Record<string, string> | null = null;
  if (rawVotes) {
    try {
      const parsed = JSON.parse(rawVotes) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        lensVotes = parsed as Record<string, string>;
      }
    } catch {
      lensVotes = null;
    }
  }

  return {
    id: row["id"] as number,
    tsEpoch: row["ts_epoch"] as number,
    projectId: (row["project_id"] as string | null) ?? null,
    sessionId: row["session_id"] as string,
    issueId: (row["issue_id"] as string | null) ?? null,
    prNumber: (row["pr_number"] as number | null) ?? null,
    agent: (row["agent"] as string | null) ?? null,
    verifier: (row["verifier"] as string | null) ?? null,
    verdict: row["verdict"] as VerificationVerdict,
    errorCount: (row["error_count"] as number | null) ?? 0,
    warningCount: (row["warning_count"] as number | null) ?? 0,
    infoCount: (row["info_count"] as number | null) ?? 0,
    lensVotes,
    summary: (row["summary"] as string | null) ?? null,
    attempt: (row["attempt"] as number | null) ?? 1,
    durationMs: (row["duration_ms"] as number | null) ?? null,
    targetSha: (row["target_sha"] as string | null) ?? null,
    baseSha: (row["base_sha"] as string | null) ?? null,
  };
}

/**
 * Append a verdict. No-op (returns null) when the store is unavailable, so
 * callers never need to guard. `tsEpoch` is injectable for deterministic tests.
 */
export function recordVerification(
  input: VerificationRecordInput,
  tsEpoch: number = Date.now(),
): VerificationRecord | null {
  const db = getVerificationDb();
  if (!db) return null;

  const result = db
    .prepare(
      `INSERT INTO verifications
         (ts_epoch, project_id, session_id, issue_id, pr_number, agent, verifier, verdict,
          error_count, warning_count, info_count, lens_votes, summary, attempt, duration_ms,
          target_sha, base_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tsEpoch,
      input.projectId ?? null,
      input.sessionId,
      input.issueId ?? null,
      input.prNumber ?? null,
      input.agent ?? null,
      input.verifier ?? null,
      input.verdict,
      input.errorCount ?? 0,
      input.warningCount ?? 0,
      input.infoCount ?? 0,
      input.lensVotes ? JSON.stringify(input.lensVotes) : null,
      input.summary ?? null,
      input.attempt ?? 1,
      input.durationMs ?? null,
      input.targetSha ?? null,
      input.baseSha ?? null,
    ) as { lastInsertRowid?: number | bigint };

  const id = Number(result.lastInsertRowid ?? 0);
  return {
    id,
    tsEpoch,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId,
    issueId: input.issueId ?? null,
    prNumber: input.prNumber ?? null,
    agent: input.agent ?? null,
    verifier: input.verifier ?? null,
    verdict: input.verdict,
    errorCount: input.errorCount ?? 0,
    warningCount: input.warningCount ?? 0,
    infoCount: input.infoCount ?? 0,
    lensVotes: input.lensVotes ?? null,
    summary: input.summary ?? null,
    attempt: input.attempt ?? 1,
    durationMs: input.durationMs ?? null,
    targetSha: input.targetSha ?? null,
    baseSha: input.baseSha ?? null,
  };
}

/** Latest verdict for a session (the gate-style lookup). Null if none / store unavailable. */
export function getLatestVerification(sessionId: string): VerificationRecord | null {
  const db = getVerificationDb();
  if (!db) return null;

  const rows = db
    .prepare(
      `SELECT * FROM verifications WHERE session_id = ? ORDER BY ts_epoch DESC, id DESC LIMIT 1`,
    )
    .all(sessionId) as Record<string, unknown>[];

  return rows.length > 0 ? rowToRecord(rows[0]) : null;
}

/**
 * Number of consecutive `blocked` verdicts for a session, counting back from the
 * latest until a `pass` is hit (a pass resets the streak). Drives the re-verify
 * retry cap so a PR can't bounce back to the agent forever. 0 if store unavailable.
 */
export function countRecentBlockedVerdicts(sessionId: string): number {
  const db = getVerificationDb();
  if (!db) return 0;

  const rows = db
    .prepare(
      `SELECT verdict FROM verifications WHERE session_id = ? ORDER BY ts_epoch DESC, id DESC`,
    )
    .all(sessionId) as { verdict: VerificationVerdict }[];

  let streak = 0;
  for (const row of rows) {
    if (row.verdict === "blocked") streak++;
    else if (row.verdict === "pass") break;
    // 'pending' rows don't break the streak and aren't counted
  }
  return streak;
}

/**
 * Most recent "why blocked" summary for an issue, across all attempts/sessions.
 * Lets a fresh attempt at the same issue read why prior attempts were blocked.
 * Null when there's no blocked verdict with a summary (or the store is unavailable).
 */
export function getLatestBlockedMemoryForIssue(issueId: string): string | null {
  const db = getVerificationDb();
  if (!db) return null;

  const rows = db
    .prepare(
      `SELECT summary FROM verifications
        WHERE issue_id = ? AND verdict = 'blocked' AND summary IS NOT NULL AND summary != ''
        ORDER BY ts_epoch DESC, id DESC LIMIT 1`,
    )
    .all(issueId) as { summary: string }[];

  return rows.length > 0 ? rows[0].summary : null;
}

/** History query for the eval/leaderboard. Newest first. Empty when store unavailable. */
export function listVerifications(filter: ListVerificationsFilter = {}): VerificationRecord[] {
  const db = getVerificationDb();
  if (!db) return [];

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.sessionId) {
    clauses.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.projectId) {
    clauses.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.agent) {
    clauses.push("agent = ?");
    params.push(filter.agent);
  }
  if (filter.verdict) {
    clauses.push("verdict = ?");
    params.push(filter.verdict);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = filter.limit && filter.limit > 0 ? `LIMIT ${Math.floor(filter.limit)}` : "";
  const rows = db
    .prepare(`SELECT * FROM verifications ${where} ORDER BY ts_epoch DESC, id DESC ${limit}`)
    .all(...params) as Record<string, unknown>[];

  return rows.map(rowToRecord);
}

/**
 * Per-agent pass rates for the leaderboard. Groups every verdict by the agent
 * that wrote the code; `passRate` excludes pending runs from the denominator.
 */
export function getAgentVerificationStats(projectId?: string): AgentVerificationStats[] {
  const db = getVerificationDb();
  if (!db) return [];

  const where = projectId ? "WHERE project_id = ? AND agent IS NOT NULL" : "WHERE agent IS NOT NULL";
  const params = projectId ? [projectId] : [];
  const rows = db
    .prepare(
      `SELECT agent,
              COUNT(*)                                      AS total,
              SUM(CASE WHEN verdict = 'pass'    THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN verdict = 'blocked' THEN 1 ELSE 0 END) AS blocked,
              SUM(CASE WHEN verdict = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM verifications
         ${where}
        GROUP BY agent
        ORDER BY passed DESC, total DESC`,
    )
    .all(...params) as Record<string, unknown>[];

  return rows.map((row) => {
    const passed = (row["passed"] as number | null) ?? 0;
    const blocked = (row["blocked"] as number | null) ?? 0;
    const pending = (row["pending"] as number | null) ?? 0;
    const decided = passed + blocked;
    return {
      agent: row["agent"] as string,
      total: (row["total"] as number | null) ?? 0,
      passed,
      blocked,
      pending,
      passRate: decided > 0 ? passed / decided : 0,
    };
  });
}
