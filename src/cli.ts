#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { generateTypes } from "./generate-types.js";

const usage = `Usage: restspec generate-types <entrypoint> [--profiles <dir>] --out <types.ts>

Generate TypeScript types from all application/json schemas in profiles/.

Options:
  -p, --profiles <dir>  Profiles directory (default: profiles/ next to entrypoint)
  -o, --out <file>      Required output TypeScript file
  -h, --help            Show help
  -v, --version         Show version
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profiles: { type: "string", short: "p" },
      out: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.help) {
    process.stdout.write(usage);
    return;
  }

  if (values.version) {
    const metadata = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(`${metadata.version}\n`);
    return;
  }

  const [command, entrypointPath] = positionals;
  if (
    command !== "generate-types" ||
    !entrypointPath ||
    positionals.length !== 2 ||
    !values.out?.trim() ||
    (values.profiles !== undefined && !values.profiles.trim())
  ) {
    throw new Error(usage.trimEnd());
  }

  await generateTypes(entrypointPath, values.out, values.profiles);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`restspec: ${message}\n`);
  process.exitCode = 1;
});
