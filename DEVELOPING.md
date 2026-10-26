# Development

Requires Node.js 22 or newer and pnpm 12.15.0, pinned in `package.json`.
The devcontainer installs that version and runs a frozen dependency install
automatically when it is created. Outside the container, install pnpm using
its [standalone installer](https://pnpm.io/installation):

```sh
curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=12.15.0 sh -
```

Open a new terminal so pnpm is on `PATH`. From the repository root, install
dependencies and build the library and CLI:

```sh
pnpm install --frozen-lockfile
pnpm run build
```

`pnpm-lock.yaml` is the only dependency lockfile. Use `pnpm add` or `pnpm
remove` to change dependencies and commit the updated manifest and lockfile.
Use `pnpm install` when intentionally reconciling changes to the manifest;
routine installs should use `--frozen-lockfile`.

Generate types for the checklist example using the built CLI:

```sh
node dist/cli.js generate-types examples/checklist-api/restspec.yml --profiles examples/checklist-api/profiles --out generated/types.ts
```

Run tests and build a package archive:

```sh
pnpm test
pnpm pack
```

Tests exercise the CLI and compile generated types with strict TypeScript
checks. Packing builds the CLI and includes its compiled files and the README;
it does not publish the package.
