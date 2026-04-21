#!/usr/bin/env node
// Hook fixture: runs forever until the Runner SIGKILLs it. Exercises the
// PreToolUse 5 s / PostToolUse 10 s timeout path.
setInterval(() => {}, 1_000);
