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
