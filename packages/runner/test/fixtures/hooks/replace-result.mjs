#!/usr/bin/env node
// Hook fixture: writes stdout JSON with replace_result payload and exits 0
// (PostToolUse pass + substitute result). Runner consumes §15.3
// stdout.replace_result and emits a §14.1 PostToolUseOutcome with
// outcome=replace_result — Finding M / SV-HOOK-06.
process.stdout.write(
  JSON.stringify({
    reason: "hook-redacted-secrets",
    replace_result: { status: "ok", redacted: true, items: 3 }
  }) + "\n"
);
process.exit(0);
