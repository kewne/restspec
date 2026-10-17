#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { generateTypes } from "./generate-types.js";

const usage = `Usage: restspec generate-types <restspec.yml> --out <types.ts>

Generate TypeScript types from all application/json schemas in profiles/.

Options:
  -o, --out <file>  Required output TypeScript file
  -h, --help        Show help
  -v, --version     Show version
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
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

  const [command, specPath] = positionals;
  if (
    command !== "generate-types" ||
    !specPath ||
    positionals.length !== 2 ||
    !values.out?.trim()
  ) {
    throw new Error(usage.trimEnd());
  }

  await generateTypes(specPath, values.out);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`restspec: ${message}\n`);
  process.exitCode = 1;
});
