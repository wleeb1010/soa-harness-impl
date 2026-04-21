export { resolvePermission } from "./resolver.js";
export {
  ConfigPrecedenceViolation,
  CAPABILITY_PERMITS,
  isControlTighteningOrEqual,
  type Capability,
  type DenyReason,
  type Handler,
  type ResolutionDecision,
  type ResolveInput,
  type ResolveOutcome
} from "./types.js";
export {
  resolvePermissionForQuery,
  type PermissionsResolveResponse,
  type QueryDecision,
  type TraceEntry,
  type TraceResult,
  type ResolveForQueryOptions
} from "./resolve-for-query.js";
export { InMemorySessionStore, type SessionStore } from "./session-store.js";
export {
  permissionsResolvePlugin,
  type PermissionsResolveRouteOptions
} from "./resolve-route.js";
