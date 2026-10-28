# Generated Client

[Generate a TypeScript module](cli.md) from your
[specification, profiles, and schemas](specification.md), then import its `root`
and resource types from your application.

## Following Links

`root.env` maps each environment name from `restspec.yml` to its entrypoint URL.
`fromRoot` accepts `root` along with one of its defined environment keys:

```ts
import { createHttpClient, fromRoot } from "@kewne/restspec";
import { root as apiRoot } from "../generated/types.js";

const client = createHttpClient();
const root = await client.get(fromRoot(apiRoot, "local"));
const subscriptionLink = root.getNamedLink("related", "subscription");
if (!subscriptionLink) throw new Error("Subscription link unavailable");
const subscription = await client.get(subscriptionLink);
```

Example imports assume the application module is in `src/`, with generated
types in `generated/` at the project root. A compatible API server must be
running at the selected environment's entrypoint URL.

Resources expose `getNamedLink(rel, name)` to look up a named link within a
relation. Known relation/name pairs infer each method's request payload and response resource
from the target profile's JSON schemas. The checklist example declares GET
response schemas and a checklist POST request with a required string `title`.
Its `getNamedLink("create", "checklists")` result carries a POST contract
that infers a checklist response resource. Named links may be absent from an
actual response, so check for `undefined` before following them.

Relation types and names containing punctuation are ordinary string arguments,
such as `checklist.getNamedLink("create-from", "instance")`. Unknown pairs and
widened string arguments are accepted by a fallback returning an untyped
`Link | undefined`. Descriptions without a name are available only through `getRel`.

## HTTP Requests

`createHttpClient(options?)` returns an `HttpClient` with lowercase `get`, `post`,
`put`, `patch`, `delete`, `head`, and `options` methods. Each method takes a link
as its first argument and the request body as its second, returning a promise
of the response resource. Request and response types are inferred from the link;
one client can follow links with different contracts. Required request schemas
require a body, while `void` request bodies can be omitted.

Links contain only `href` and optional `name` and `title` metadata at runtime.
POST, PUT, PATCH, DELETE, and
OPTIONS serialize supplied payloads as JSON and send `Content-Type: application/json`.
An `undefined` payload omits both the body and its content type. GET and HEAD
never send request bodies, even when a schema or explicit tuple declares one.

All methods send `Accept: application/hal+json, application/json` and use the
same destination-scoped credentials. Nonempty JSON responses become resources
with `properties`, `getRel`, and `getNamedLink`, including navigable relative links.
HEAD, HTTP 204/205, and other successful responses with an empty body resolve to
`undefined`. Method tuples remain unchanged, so a declared response resource
does not guarantee a body at runtime. Invalid nonempty JSON rejects.

Non-success HTTP responses reject with an error containing the requested URL,
status code, and status text, including for HEAD requests.

## POST and PUT

POST creates a checklist using a request and response inferred from the example
specification:

```ts
const createLink = root.getNamedLink("create", "checklists");
if (!createLink) throw new Error("Checklist creation unavailable");
const checklist = await client.post(createLink, {
   title: "My new checklist",
});
console.log(checklist.properties.title);
```

For PUT, the checklist profile declares a named `edit` link and a request schema
requiring a full replacement of the checklist's writable `title` and `items`.
Both the request body and the response resource are inferred:

```ts
const editLink = checklist.getNamedLink("edit", "checklist");
if (!editLink) throw new Error("Checklist editing unavailable");
const replaced = await client.put(editLink, {
   title: "Weekly checklist",
   items: checklist.properties.items,
});
console.log(replaced.properties.title);
```

PUT supplies the complete replacement payload required by the API, rather than
a partial update. Actual payload requirements and link protocols are defined by
the API's contract.

## General Relation Processing

Use `getRel(rel)` to inspect all links in a relation, including unnamed links.
The generated interface has one overload accepting a union of known relation
names for editor suggestions and another accepting any string. Both return
untyped `Link[]`; absent relations return an empty array.

```ts
for (const link of root.getRel("related")) {
   console.log(link.name, link.title, link.href);
}
```

`getRel` returns an array of links with optional `name` and `title` properties
and a readonly `href` string. It does not accept caller-supplied type arguments.
Use `getNamedLink` with a known pair for inferred request and response types.
Client methods absent from a link's contract accept `void` and return
`Promise<unknown>`. All `getRel` results, unknown named pairs, and external
targets without local schemas use those defaults. These methods do not validate
response data against the specification. `HttpClient` exposes only the seven
standard methods listed above, even if a link's tuples describe a custom method.

## Entering Through a Resource URL

To enter the API through an existing resource URL instead of its root, use
`fromHref` with the expected resource type:

```ts
import { createHttpClient, fromHref } from "@kewne/restspec";
import type { Checklist } from "../generated/types.js";

const client = createHttpClient();
const bookmarkLink = fromHref<Checklist>("https://api.example.com/checklists/123");
const checklist = await client.get(bookmarkLink);
```

The resource type is supplied by the caller; it does not validate the response.
Without a resource type argument, the GET response type is `unknown`.

## Generated Module Reference

The checklist example's generated module includes the following declarations
(the `Root` interface is abbreviated here; the generated interface also includes
the typed `getNamedLink` overloads described above):

```ts
import type { ApiRoot, Link } from "@kewne/restspec";

export interface Root {
   properties: { [key: string]: unknown };
   getRel(rel: "related" | "create"): Link[];
   getRel(rel: string): Link[];
   getNamedLink(rel: string, name: string): Link | undefined;
}

export const root: ApiRoot<Root, { local: string; staging: string; production: string; }, {
   get: [void, Root];
   post: [void, unknown];
   put: [void, unknown];
   patch: [void, unknown];
   delete: [void, unknown];
   head: [void, unknown];
   options: [void, unknown];
}> = {
   env: {
      local: "http://localhost:3000/",
      staging: "https://staging.example.com/",
      production: "https://example.com/",
   },
   profile: "https://checklists.keeoon.dev/profiles/root",
};
```

Environment descriptions in the specification become documentation comments in
the generated module. The third `ApiRoot` type parameter preserves all
root-profile method tuples in the returned link. Existing
`ApiRoot<Resource, ENV>` declarations still default to a GET response of
`Resource`.

## Credentials

Credentials are configured on the client, not on links. Supply a destination-keyed
map to scope bearer tokens to the intended origins, hosts, or hostnames:

```ts
const client = createHttpClient({
   credentials: {
      [new URL(apiRoot.env.production).origin]: { type: "bearer", token: accessToken },
   },
});
const root = await client.get(fromRoot(apiRoot, "production"));
```

For APIs spanning multiple domains, supply a credentials map:

```ts
const client = createHttpClient({
   credentials: {
      "https://api.example.com": { type: "bearer", token: apiToken },
      "files.example.com": { type: "bearer", token: filesToken },
   },
});
```

The client selects credentials by exact origin, then host (including port), then
hostname. URL keys are normalized to their origin. Hostname keys apply across
schemes and ports; prefer HTTPS origin keys for narrowly scoped credentials.
Requests to discovered links send `Authorization: Bearer ...` only when their
destination matches the client's configuration. Unconfigured destinations receive no
authorization header. No wildcard or subdomain matching is performed.

The same link can be used by multiple clients with different credentials;
links do not retain credentials or a reference to their originating client.

## Migrating From Link Requests

Replace `link.request.get()` with `client.get(link)` and
`link.request.post(body)` with `client.post(link, body)`. The `request` property
has been removed; there is no compatibility wrapper.

Move credential options from `fromRoot` and `fromHref` to `createHttpClient`.
The single-token shorthand is no longer accepted. Use a map keyed by the
entrypoint's origin, as shown above, to preserve its previous origin scope.

[Return to the overview](../README.md).
