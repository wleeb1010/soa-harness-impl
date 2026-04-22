#!/usr/bin/env node
// Hook fixture: writes stdout JSON with replace_args payload and exits 0
// (Allow + substitute args). Runner consumes §15.3 stdout.replace_args and
// emits a §14.1 PreToolUseOutcome with outcome=replace_args — Finding L /
// SV-HOOK-05.
process.stdout.write(
  JSON.stringify({
    reason: "hook-substituted-args",
    replace_args: { path: "/tmp/safe-path", mode: "rw" }
  }) + "\n"
);
process.exit(0);
