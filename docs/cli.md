# TypeScript Type Generation

Requires Node.js 22 or newer and npm. Install the library in your project:

```sh
npm install @kewne/restspec
```

With your entrypoint specification in `restspec.yml` and your profile files in
`profiles/`, generate a TypeScript module:

```sh
npx restspec generate-types restspec.yml --profiles profiles --out generated/types.ts
```

Import the generated module from your application as shown in the
[client guide](client.md). Regenerate it whenever you change your specification,
profiles, or schemas. See the [specification guide](specification.md) for the
input format and the [checklist example](../examples/checklist-api/restspec.yml)
for sample inputs.

## Command Options

Use `npx restspec --help` for usage or `npx restspec --version` for the package version.
`generate-types` accepts either:

- the entrypoint specification file as its positional argument and an optional
  `--profiles` (also `-p`) directory containing profile YAML files (defaulting
  to `profiles/` next to the entrypoint file), or
- a `--config` (also `-c`) YAML file specifying `entrypoint` and `profiles`,

along with a required `--out` (also `-o`) option naming a `.ts` file. Paths on
the command line are relative to the current working directory. Missing output
directories are created; existing output is replaced only after successful
generation. Input files cannot also be used as output.

## Configuration Files

When using `--config`, relative file paths are resolved against the directory
containing the config file, and `file:` and `https:` URLs are dereferenced:

```yaml
entrypoint: ./restspec.yml
profiles:
  - https://checklists.keeoon.dev/profiles/root
  - url: https://checklists.keeoon.dev/profiles/checklist
    location: ./profiles/checklist.yml
```

For a config saved as `restspec.config.yml`, run:

```sh
npx restspec generate-types --config restspec.config.yml --out generated/types.ts
```

[Return to the overview](../README.md).
