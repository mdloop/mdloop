#!/usr/bin/env node
// Drift gate (`pnpm docs:check`): regenerates the MCP-tool and CLI
// references in memory and diffs them against what's committed under
// REFERENCE_DIR. Non-zero exit on any difference — this is what makes "the
// docs say 18 MCP tools, the server registers 19" a build failure instead of
// a discovery someone makes months later. It has caught exactly that.
//
// One location, not two: there is no website in this repository, so the
// committed file under docs/ is the only copy — no separate evidence file to
// keep in sync with it.
//
// There is no "regions" generator here: pricing and subprocessor commitments
// belong to whoever operates a deployment, not to the core (CONSTITUTION §7),
// so there is no internal doc to excerpt them from in the first place.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { REFERENCE_DIR } from './paths.js';
import { generateMcpReference } from './mcp.js';
import { generateCliReference } from './cli.js';

interface Expected {
  file: string;
  markdown: string;
}

// The `leaked` flag that used to ride alongside this is gone with the regions
// generator: it guarded against a too-broad `public:start` marker excerpting
// private content out of an internal doc into a published page — there is no
// such internal doc or published page in this repository, so there is
// nothing here for a marker to leak from. Removed rather than left
// permanently false, which would read as a leak check that keeps passing.
function collectExpected(): Expected[] {
  return [
    { file: 'mcp-reference.md', markdown: generateMcpReference().markdown },
    { file: 'cli-reference.md', markdown: generateCliReference().markdown },
  ];
}

function main(): void {
  const expected = collectExpected();
  let drifted = false;

  for (const { file, markdown } of expected) {
    const committedPath = path.join(REFERENCE_DIR, file);
    if (!existsSync(committedPath)) {
      console.error(`DRIFT: ${file} is not committed at ${committedPath} — run \`pnpm gen:docs\`.`);
      drifted = true;
      continue;
    }
    const committed = readFileSync(committedPath, 'utf8');
    if (committed !== markdown) {
      console.error(
        `DRIFT: ${committedPath} does not match freshly generated output — run \`pnpm gen:docs\`.`,
      );
      drifted = true;
    }
  }

  if (drifted) {
    process.exitCode = 1;
  } else {
    console.log(
      `docs:check — ${String(expected.length)} generated file(s) match committed output under docs/reference.`,
    );
  }
}

main();
