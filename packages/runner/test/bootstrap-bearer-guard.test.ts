import { describe, it, expect } from "vitest";
import {
  assertBootstrapBearerListenerSafe,
  BootstrapBearerOnPublicListener
} from "../src/guards/index.js";

describe("T-05 — SOA_RUNNER_BOOTSTRAP_BEARER public-listener guard", () => {
  it("fires when env set + TLS + non-loopback host", () => {
    expect(() =>
      assertBootstrapBearerListenerSafe({
        bearer: "op-bootstrap-xyz",
        tlsEnabled: true,
        host: "runner.example.com"
      })
    ).toThrow(BootstrapBearerOnPublicListener);
  });

  it("fires when env set + TLS + 0.0.0.0 (binds non-loopback interfaces too)", () => {
    expect(() =>
      assertBootstrapBearerListenerSafe({
        bearer: "op-bootstrap-xyz",
        tlsEnabled: true,
        host: "0.0.0.0"
      })
    ).toThrow(BootstrapBearerOnPublicListener);
  });

  it("silent when env set + TLS + loopback (127.0.0.1)", () => {
    expect(() =>
      assertBootstrapBearerListenerSafe({
        bearer: "op-bootstrap-xyz",
        tlsEnabled: true,
        host: "127.0.0.1"
      })
    ).not.toThrow();
  });

  it("silent when env set + TLS + loopback (::1, localhost)", () => {
    for (const host of ["::1", "localhost"]) {
      expect(() =>
        assertBootstrapBearerListenerSafe({ bearer: "op-bootstrap-xyz", tlsEnabled: true, host })
      ).not.toThrow();
    }
  });

  it("silent when env unset (any bind)", () => {
    expect(() =>
      assertBootstrapBearerListenerSafe({
        bearer: undefined,
        tlsEnabled: true,
        host: "runner.example.com"
      })
    ).not.toThrow();
    expect(() =>
      assertBootstrapBearerListenerSafe({ bearer: "", tlsEnabled: true, host: "0.0.0.0" })
    ).not.toThrow();
  });

  it("silent when env set + no TLS (guard only fires on TLS-on-non-loopback per M1 scope)", () => {
    expect(() =>
      assertBootstrapBearerListenerSafe({
        bearer: "op-bootstrap-xyz",
        tlsEnabled: false,
        host: "runner.example.com"
      })
    ).not.toThrow();
  });
});
