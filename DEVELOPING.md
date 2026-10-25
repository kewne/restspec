# Development

Requires Node.js 22 or newer and npm. From the repository root, install
dependencies and build the library and CLI:

```sh
npm install
npm run build
```

Generate types for the checklist example using the built CLI:

```sh
node dist/cli.js generate-types examples/checklist-api/restspec.yml --profiles examples/checklist-api/profiles --out generated/types.ts
```

Run tests and build a package archive:

```sh
npm test
npm pack
```

Tests exercise the CLI and compile generated types with strict TypeScript
checks. Packing builds the CLI and includes its compiled files and the README;
it does not publish the package.