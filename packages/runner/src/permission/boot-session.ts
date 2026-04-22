/**
 * Canonical session_id for runner-lifetime System Event Log records —
 * startup probes, retention sweeps, consolidation ticks, and any
 * other pre-/cross-session lifecycle activity the Runner emits.
 *
 * MUST match the §12.1 `session_id` pattern `^ses_[A-Za-z0-9]{16,}$`
 * so GET /logs/system/recent's parameter validator accepts it. Earlier
 * revisions used `ses_runner_boot_____` which failed that regex and
 * blocked validator observation (Finding AO). The rename is uniform
 * across the process — nothing should parse the trailing characters.
 *
 * Registered in the session store on Runner boot (see start-runner.ts)
 * with the bootstrap bearer as the authorized reader. The session
 * never "starts" in the §12.6 sense (no /sessions POST, no
 * SessionStart event, no persistence file); it's a logical handle for
 * boot-scoped observability.
 */
export const BOOT_SESSION_ID = "ses_runnerBootLifetime";
