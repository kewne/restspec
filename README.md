# restspec

restspec is an API specification format for hypermedia-based APIs.

## Why restspec?

Hypermedia-based APIs return links that clients should use to navigate the API
and discover available interactions. Rather than relying on a predefined set of
endpoint URLs, clients follow the links provided in API responses.

This differs from the endpoint-oriented model commonly described with formats
such as OpenAPI. The shift from predefined endpoints to navigation through
links calls for a specification format designed around hypermedia.

## Specification Structure

A restspec specification is composed of three components:

1. **The main `restspec.yml` file** describes the API's entrypoint, where clients
   begin interacting with the API.
2. **Profile files** describe the entities in the API.
3. **Schema files** describe the payloads for each entity.

Together, these components describe where interaction begins, which entities
the API exposes, and the structure of their payloads.

### Main Specification: `restspec.yml`

The main file defines where clients begin interacting with the API:

- `url`: the API's entrypoint URL.
- `rootProfile`: the canonical URL identifying the profile describing the
   entrypoint's entity. It matches that profile's `profile` value, not a local
   file path.

Only the entrypoint URL needs to be known in advance. Clients discover further
URLs through links returned by the API.

### Profile Files

Profile files describe the API's entities and the links available from them.
Each YAML profile contains:

- `profile`: a URI identifying the entity's profile, not a fixed API endpoint.
- `schema`: a mapping from payload media types, such as `application/json`, to
   schema file paths resolved relative to the profile file.
- `rels`: link descriptions grouped by relation type. Each description includes
   a `name`, a human-readable `description`, and the target entity's `profile` URI.
   A profile with no outgoing relations uses an empty mapping.

Relation types describe protocols for how clients can interact with linked
entities. The simplest relation type is `related`: it identifies an entity that
clients can navigate to by sending a `GET` request to the link's URL.

Clients use the actual links returned in API responses to perform these
interactions according to the relation type's protocol; profiles do not define
a URL for every operation.

### Schema Files

Schema files describe the structure of entity payloads, including their fields,
types, required properties, and constraints. Profiles associate these schemas
with the corresponding payload media types.

JSON payloads can be described using JSON Schema. A schema can define nested
objects and arrays, nullable values, and alternative payload shapes.

Schemas describe payload structure, while profiles describe entity relationships
and discoverable interactions. Keeping these concerns separate allows each
component to focus on a different part of the API contract.

## TypeScript Type Generation

Requires Node.js 22 or newer and npm. From this repository:

```sh
npm install
npm run build
node dist/cli.js generate-types examples/checklist-api/restspec.yml --profiles examples/checklist-api/profiles --out generated/types.ts
```

The npm package exposes the `restspec` command. To install this local package
globally after building it:

```sh
npm install --global .
restspec generate-types examples/checklist-api/restspec.yml --profiles examples/checklist-api/profiles --out generated/types.ts
```

Use `restspec --help` for usage or `restspec --version` for the package version.
`generate-types` accepts the entrypoint specification file as its positional
argument, an optional `--profiles` (also `-p`) directory containing profile
YAML files (defaulting to `profiles/` next to the entrypoint file), and a
required `--out` (also `-o`) option naming a `.ts` file. Paths on the command
line are relative to the current working directory. Missing output directories
are created; existing output is replaced only after successful generation. Input
files cannot also be used as output.

### Generated Types

[Quicktype](https://github.com/glideapps/quicktype) generates one combined module
of exported TypeScript interfaces and type aliases, without runtime converters
or validators. Date and date-time fields remain strings, and string enums use
union types. Empty-object, array, and primitive payloads also have named exports.

Schema payloads are inlined in each resource's `properties`, including nested
objects and array items. Named payload types are retained only where recursive
references require them.

Top-level names come from the schema's nonempty `title`, or its filename without
`.json` when no title is present. Quicktype converts these into TypeScript
identifiers: `Checklist instance` becomes `ChecklistInstance`, for example.
Duplicate titles or fallback names are rejected rather than silently dropping
a schema.

```ts
import { root } from "./generated/types.js";
import type { Checklist, ChecklistInstance, Root, Subscription } from "./generated/types.js";
```

Generated types are not a substitute for JSON Schema validation. Quicktype may
approximate constraints, including exclusive `oneOf`, `not`, and some JSON Schema
2020-12 keywords. In the checklist example, `Subscription.properties` has a status union
and an optional `endDate`; its generated type does not enforce that `ACTIVE`
requires an end date and `INACTIVE` forbids one. The source schemas are not
modified during generation.

### Development

```sh
npm test
npm pack
```

Tests exercise the CLI and compile generated types with strict TypeScript
checks. Packing builds the CLI and includes its compiled files and this README;
it does not publish the package.

## Generated Client

The checklist example's generated module includes:

```ts
import type { ApiRoot, Link, Methods } from "restspec";

export interface Root {
   properties: { [key: string]: unknown };
   getRel<METHODS extends Methods>(rel: string): Link<METHODS>[];
}

export const root: ApiRoot<Root> = {
   url: "http://localhost:3000/",
   profile: "https://checklists.keeoon.dev/profiles/root",
};
```

Client usage with an explicitly typed relation:

```ts
import { fromRoot } from "restspec";
import { root as apiRoot } from "./generated/types.js";
import type { Checklist } from "./generated/types.js";

const rootLink = fromRoot(apiRoot);
const root = await rootLink.request.get();

const createLink = root
   .getRel<{ post: [{ title: string }, Checklist] }>("create")
   .find((link) => link.name === "checklists");

if (createLink) {
   const checklist = await createLink.request.post({ title: "My new checklist" });
   console.log(checklist.properties.title);
}
```

`getRel` returns an array of links with `name`, `title`, a readonly `href` string,
and `request` properties.
Concrete method tuples specify request bodies and response resources; other
common HTTP methods accept `unknown` and return `Promise<unknown>`.

Resources also expose a read-only `rels` getter, grouped by relation type and
known link name:

```ts
const root = await fromRoot(apiRoot).request.get();
const subscription = await root.rels.related.subscription.request.get();
await root.rels.related.checklists.request.post({ title: "My new checklist" });
```

Named links infer their GET response resource from the target profile's local
JSON schema. External targets and targets without a JSON schema return `unknown`.
Other HTTP methods retain the default `unknown` bodies and responses; use
`getRel` with explicit method tuples when those types are needed. Relation types
and names containing punctuation use bracket access, such as
`checklist.rels["create-from"].instance`. Descriptions without a name are available
only through `getRel`.

To enter the API through an existing resource URL instead of its root, use
`fromHref` with the expected resource type:

```ts
import { fromHref } from "restspec";
import type { Checklist } from "./generated/types.js";

const bookmarkLink = fromHref<Checklist>("https://api.example.com/checklists/123");
const checklist = await bookmarkLink.request.get();
```

The resource type is supplied by the caller; it does not validate the response.
Without a resource type argument, the GET response type is `unknown`.

These examples illustrate the client types only. `fromRoot` and `fromHref`
are currently stubs and do not yet implement HTTP requests or resource navigation.
