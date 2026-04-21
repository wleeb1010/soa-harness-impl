#!/usr/bin/env node
// Demo PreToolUse hook (§15). Reads the Runner's stdin JSON, writes a
// single-line human-readable "reason" to stdout, and exits 0 (Allow).
// Swap this out for real policy logic; non-zero exit codes → Deny/Prompt
// per §15.3.

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
});
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(buf);
  } catch {
    process.stderr.write("[pre-tool-use] malformed stdin\n");
    process.exit(1);
  }
  const tool = payload?.tool?.name ?? "<unknown>";
  process.stdout.write(JSON.stringify({ reason: `demo-hook-ok:${tool}` }) + "\n");
  process.exit(0);
});
