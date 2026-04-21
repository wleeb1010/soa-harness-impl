#!/usr/bin/env node
// Hook fixture: writes a valid single-line stdout JSON and exits 0 (Allow).
process.stdout.write(JSON.stringify({ reason: "approved-by-fixture" }) + "\n");
process.exit(0);
