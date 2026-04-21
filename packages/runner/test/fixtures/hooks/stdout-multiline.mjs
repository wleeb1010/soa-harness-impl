#!/usr/bin/env node
// Hook fixture: writes multi-line stdout which violates the §15.3 single-line
// requirement. The Runner MUST flag this with reason=hook-stdout-invalid.
process.stdout.write("line one\nline two\n");
process.exit(0);
