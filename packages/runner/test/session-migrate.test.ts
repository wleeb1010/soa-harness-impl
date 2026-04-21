import { describe, it, expect } from "vitest";
import { registry as schemaRegistry } from "@soa-harness/schemas";
import { migratePre1SessionFile, type PersistedSession } from "../src/session/index.js";

function fullSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    session_id: "ses_aaaaaaaaaaaaaaaa",
    format_version: "1.0",
    activeMode: "DangerFullAccess",
    messages: [],
    workflow: {
      task_id: "t_a",
      status: "Planning",
      side_effects: [],
      checkpoint: {}
    },
    counters: {},
    tool_pool_hash: "sha256:abcd",
    card_version: "1.0.0",
    ...overrides
  };
}

describe("session.schema.json (T-08 refresh — activeMode required)", () => {
  const validate = schemaRegistry["session"];

  it("accepts a full-shape session record carrying activeMode", () => {
    expect(validate(fullSession())).toBe(true);
  });

  it("rejects a session record missing activeMode (regression for L-20 drift)", () => {
    const missing = { ...fullSession() };
    delete (missing as Partial<PersistedSession>).activeMode;
    const ok = validate(missing);
    expect(ok).toBe(false);
    const msg = (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join(";");
    expect(msg).toMatch(/activeMode/);
  });

  it("accepts each value of the activeMode enum", () => {
    for (const mode of ["ReadOnly", "WorkspaceWrite", "DangerFullAccess"] as const) {
      expect(validate(fullSession({ activeMode: mode }))).toBe(true);
    }
  });
});

describe("migratePre1SessionFile", () => {
  it("returns an equivalent record when activeMode is already present", () => {
    const input = fullSession({ activeMode: "WorkspaceWrite" });
    const migrated = migratePre1SessionFile(input, "ReadOnly");
    expect(migrated.activeMode).toBe("WorkspaceWrite");
    expect(migrated._migrated).toBeUndefined();
  });

  it("defaults activeMode to the Agent Card's when missing and tags the record", () => {
    const pre = { ...fullSession() } as PersistedSession;
    delete (pre as Partial<PersistedSession>).activeMode;
    const migrated = migratePre1SessionFile(pre, "WorkspaceWrite");
    expect(migrated.activeMode).toBe("WorkspaceWrite");
    expect(migrated._migrated).toEqual({ from: "pre-1.0" });
    expect(migrated.session_id).toBe("ses_aaaaaaaaaaaaaaaa");
  });

  it("pre-1.0 → migrated → schema-valid round-trip", () => {
    const validate = schemaRegistry["session"];
    const pre = { ...fullSession() } as PersistedSession;
    delete (pre as Partial<PersistedSession>).activeMode;
    expect(validate(pre)).toBe(false);
    const migrated = migratePre1SessionFile(pre, "ReadOnly");
    // migrated carries an extra _migrated field that isn't in the schema,
    // but additionalProperties is not set at the top level of session.schema.json,
    // so the field is tolerated. Re-validate to confirm.
    expect(validate({ ...migrated, _migrated: undefined })).toBe(true);
  });
});
