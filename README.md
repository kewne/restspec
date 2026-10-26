# restspec

restspec is an API specification format for hypermedia-based APIs.

## Why restspec?

Hypermedia-based APIs return links that clients should use to navigate the API
and discover available interactions. Rather than relying on a predefined set of
endpoint URLs, clients follow the links provided in API responses.

This differs from the endpoint-oriented model commonly described with formats
such as OpenAPI. The shift from predefined endpoints to navigation through
links calls for a specification format designed around hypermedia.

[Why use hypermedia to build an API?](https://github.com/kewne/restspec/blob/main/docs/why-hypermedia.md)

## Quick Start

Requires Node.js 22 or newer and pnpm. Install the library in your project:

```sh
pnpm add @kewne/restspec
```

An entrypoint specification identifies the API's root profile and environment URL:

```yaml
env:
   local:
      url: http://localhost:3000/
rootProfile: https://checklists.keeoon.dev/profiles/root
```

The root profile describes discoverable links, not fixed endpoint URLs:

```yaml
profile: https://checklists.keeoon.dev/profiles/root
rels:
   related:
      -
         name: subscription
         profile: https://checklists.keeoon.dev/profiles/subscription
         description: The current user's subscription.
   create:
      -
         name: checklists
         profile: https://checklists.keeoon.dev/profiles/checklist-list
         description: Creates a checklist for the current user.
```

Target profiles associate HTTP methods with payload schemas. For example,
the subscription profile describes its GET response:

```yaml
profile: https://checklists.keeoon.dev/profiles/subscription
schema:
   application/json:
      get:
         response: ../schemas/json/subscription.json
rels: {}
```

These are excerpts; the full input also needs the checklist profiles and all
referenced schemas. With the entrypoint in `restspec.yml`, profiles in
`profiles/`, and schemas at their referenced paths, generate a TypeScript module:

```sh
pnpm exec restspec generate-types restspec.yml --profiles profiles --out generated/types.ts
```

Using the checklist specification, follow a GET link from an application module
in `src/`. A compatible API server must be running at the selected environment's
entrypoint URL; type generation does not start a server.

```ts
import { fromRoot } from "@kewne/restspec";
import { root as apiRoot } from "../generated/types.js";

const root = await fromRoot(apiRoot, "local").request.get();
const subscription = await root.rels.related.subscription.request.get();
console.log(subscription.properties.status);
```

**Runtime limitation:** only GET without request bodies is currently implemented.
The POST creation and PUT replacement calls below demonstrate TypeScript
contracts only and cannot currently be executed.

POST uses generated, type-safe navigation and request methods. The request body
and response type are inferred from the target profile's schemas:

```ts
const checklist = await root.rels.create.checklists.request.post({
   title: "My new checklist",
});
console.log(checklist.properties.title);
```

PUT also uses generated navigation and request methods. The checklist profile's
named `edit` link accepts a full replacement of its writable `title` and `items`:

```ts
const replaced = await checklist.rels.edit.checklist.request.put({
   title: "Weekly checklist",
   items: checklist.properties.items,
});
console.log(replaced.properties.title);
```

## Documentation

- [Specification structure](https://github.com/kewne/restspec/blob/main/docs/specification.md)
- [CLI usage and configuration](https://github.com/kewne/restspec/blob/main/docs/cli.md)
- [Client usage, type contracts, and credentials](https://github.com/kewne/restspec/blob/main/docs/client.md)
- [Contributing](https://github.com/kewne/restspec/blob/main/DEVELOPING.md)
