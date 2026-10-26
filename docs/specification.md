# Specification Structure

A restspec specification is composed of three components:

1. **The main `restspec.yml` file** describes the API's entrypoint, where clients
   begin interacting with the API.
2. **Profile files** describe the entities in the API.
3. **Schema files** describe the payloads for each entity.

Together, these components describe where interaction begins, which entities
the API exposes, and the structure of their payloads. See the
[checklist specification](../examples/checklist-api/restspec.yml) for an example.

## Main Specification: `restspec.yml`

The main file defines where clients begin interacting with the API:

- `env`: a mapping of environment names (such as `local`, `staging`, or
   `production`) to environment definitions. Each environment includes a
   required `url` for that environment's entrypoint and an optional
   human-readable `description`.
- `rootProfile`: the canonical URL identifying the profile describing the
   entrypoint's entity. It matches that profile's `profile` value, not a local
   file path.

```yaml
env:
  local:
    url: http://localhost:3000/
    description: Local development environment.
  staging:
    url: https://staging.example.com/
    description: Staging environment.
  production:
    url: https://example.com/
    description: Production environment.
rootProfile: https://checklists.keeoon.dev/profiles/root
```

Only the entrypoint URLs need to be known in advance. Clients discover further
URLs through links returned by the API.

## Profile Files

Profile files describe the API's entities and the links available from them.
Each YAML profile contains:

- `profile`: a URI identifying the entity's profile, not a fixed API endpoint.
- `schema`: an optional mapping from payload media types, such as
   `application/json`, to HTTP methods. Each method can specify a `request`
   schema, a `response` schema, or both. Schema paths are resolved relative to
   the profile file; `file:` and `https:` URLs are also supported.
- `rels`: link descriptions grouped by relation type. Each description includes
   a `name`, a human-readable `description`, and the target entity's `profile` URI.
   A profile with no outgoing relations uses an empty mapping.

```yaml
profile: https://example.com/profiles/checklist
schema:
   application/json:
      get:
         response: ../schemas/checklist.json
      post:
         request: ../schemas/create-checklist.json
         response: ../schemas/checklist.json
      patch:
         request: ../schemas/update-checklist.json
rels: {}
```

Supported method keys are `get`, `post`, `put`, `patch`, `delete`, `head`, and
`options`. A missing request schema means `void`: callers omit the body. A
missing response schema means `unknown`, not `void`, even for methods commonly
used without a response body. Methods and the entire `schema` mapping may be
omitted. The former `schema.application/json: path` shorthand is not supported.
Type generation currently consumes only `application/json` schemas.

Relation types describe protocols for how clients can interact with linked
entities. The simplest relation type is `related`: it identifies an entity that
clients can navigate to by sending a `GET` request to the link's URL.

Clients use the actual links returned in API responses to perform these
interactions according to the relation type's protocol; profiles do not define
a URL for every operation.

## Schema Files

Schema files describe the structure of entity payloads, including their fields,
types, required properties, and constraints. Profiles associate these schemas
with the corresponding payload media types.

JSON payloads can be described using JSON Schema. A schema can define nested
objects and arrays, nullable values, and alternative payload shapes.

Schemas describe payload structure, while profiles describe entity relationships
and discoverable interactions. Keeping these concerns separate allows each
component to focus on a different part of the API contract.

## Next Steps

- [Generate TypeScript types](cli.md).
- [Use the generated client](client.md).
- [Return to the overview](../README.md).
