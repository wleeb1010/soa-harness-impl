#!/usr/bin/env node
// Hook fixture: throws before exiting. Node process dies with non-zero code.
throw new Error("intentional crash for test fixture");
