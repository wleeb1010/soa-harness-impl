import { describe, it, expect } from "vitest";
import { registry, schemaNames } from "../src/registry.js";

describe("schemas registry", () => {
  it("contains at least the Core schemas the plan expects", () => {
    const required = [
      "agent-card",
      "canonical-decision",
      "crl",
      "initial-trust",
      "release-manifest",
      "session",
      "stream-event",
      "stream-event-payloads"
    ];
    for (const name of required) {
      expect(schemaNames, `missing schema ${name}`).toContain(name);
    }
  });

  it("every entry is a callable validator", () => {
    for (const name of schemaNames) {
      const validate = registry[name];
      expect(typeof validate, `registry["${name}"] should be a function`).toBe("function");
    }
  });

  it("every validator runs without throwing on both null and an empty object", () => {
    for (const name of schemaNames) {
      const validate = registry[name];
      expect(() => validate(null), `${name} threw on null`).not.toThrow();
      expect(() => validate({}), `${name} threw on {}`).not.toThrow();
    }
  });

  it("schemas with required root fields reject an empty object", () => {
    // These are the schemas whose top-level is an object with required properties.
    // $defs-style schemas (e.g. ui-derived-payloads, stream-event-payloads) have no root required set
    // and are excluded here — they're validated via sub-refs, not their root.
    const rootObjectSchemas = [
      "agent-card",
      "canonical-decision",
      "initial-trust",
      "release-manifest",
      "session"
    ];
    for (const name of rootObjectSchemas) {
      if (!schemaNames.includes(name)) continue;
      const validate = registry[name];
      const ok = validate({});
      expect(ok, `${name} accepted {} — missing required root property check`).toBe(false);
    }
  });
});
