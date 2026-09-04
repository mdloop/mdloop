#!/usr/bin/env node
// Runs both reference generators in one pass (`pnpm gen:docs`). Each is also
// independently runnable (`pnpm gen:mcp`, `pnpm gen:cli`) — this is just the
// convenience entrypoint. Calls each
// module's `main` directly rather than spawning subprocesses, so it works
// identically whether run from source (ts-node-style tooling) or from the
// compiled `dist/` output `pnpm build:gen-docs` produces.

import { main as generateMcp } from './mcp.js';
import { main as generateCli } from './cli.js';

generateMcp();
generateCli();
