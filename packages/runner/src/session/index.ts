export {
  migratePre1SessionFile,
  type MigratedSession,
  type PersistedSession
} from "./migrate.js";

export {
  SessionPersister,
  SessionFormatIncompatible,
  type SessionPersisterOptions,
  type WriteSessionOptions,
  type SessionFormatIncompatibleReason
} from "./persist.js";

export { sessionStatePlugin, type SessionStateRouteOptions } from "./state-route.js";

export {
  resumeSession,
  CardVersionDrift,
  type ResumeContext,
  type ResumeOutcome,
  type ResumeOutcomeKind,
  type ResumedSideEffect,
  type PersistedSideEffect,
  type ToolCompensationSupport
} from "./resume.js";

export {
  scanAndResumeInProgressSessions,
  scanHasHardFailure,
  IN_PROGRESS_STATUSES,
  TERMINAL_STATUSES,
  type ScanOutcomeEntry,
  type ScanAndResumeOptions
} from "./boot-scan.js";
