# Generated Client

[Generate a TypeScript module](cli.md) from your
[specification, profiles, and schemas](specification.md), then import its `root`
and resource types from your application.

## Following Links

`root.env` maps each environment name from `restspec.yml` to its entrypoint URL.
`fromRoot` accepts `root` along with one of its defined environment keys:

```ts
import { fromRoot } from "@kewne/restspec";
import { root as apiRoot } from "../generated/types.js";

const root = await fromRoot(apiRoot, "local").request.get();
const subscription = await root.rels.related.subscription.request.get();
```

Example imports assume the application module is in `src/`, with generated
types in `generated/` at the project root. A compatible API server must be
running at the selected environment's entrypoint URL.

Resources expose a read-only `rels` getter, grouped by relation type and known
link name. Named links infer each method's request payload and response resource
from the target profile's JSON schemas. The checklist example declares GET
response schemas and a checklist POST request with a required string `title`.
Its `root.rels.create.checklists.request.post({ title: "New checklist" })`
contract infers a checklist response resource.

Relation types and names containing punctuation use bracket access, such as
`checklist.rels["create-from"].instance`. Descriptions without a name are available
only through `getRel`.

## Runtime Limitations

**Links currently execute only GET requests without request bodies.**
Method-specific schemas and explicit tuples provide TypeScript contracts;
they do not implement POST, PUT, PATCH, DELETE, HEAD, OPTIONS, or GET request-body
serialization. The POST and PUT examples below illustrate type contracts only
and cannot currently be executed.

## POST and PUT Contracts

POST creates a checklist using a request and response inferred from the example
specification:

```ts
const checklist = await root.rels.create.checklists.request.post({
   title: "My new checklist",
});
console.log(checklist.properties.title);
```

For PUT, the checklist profile declares a named `edit` link and a request schema
requiring a full replacement of the checklist's writable `title` and `items`.
Both the request body and the response resource are inferred:

```ts
const replaced = await checklist.rels.edit.checklist.request.put({
   title: "Weekly checklist",
   items: checklist.properties.items,
});
console.log(replaced.properties.title);
```

PUT supplies the complete replacement payload required by the API, rather than
a partial update. Actual payload requirements and link protocols are defined by
the API's contract.

## Explicitly Typed Relations

Use explicit `getRel` tuples for caller-known contracts absent from the
specification. Each tuple specifies a request body and a response resource.
This POST example is also type-contract-only:

```ts
import type { Checklist } from "../generated/types.js";

const createLink = root
   .getRel<{ post: [{ title: string }, Checklist] }>("create")
   .find((link) => link.name === "checklists");

if (createLink) {
   const checklist = await createLink.request.post({ title: "My new checklist" });
   console.log(checklist.properties.title);
}
```

`getRel` returns an array of links with `name`, `title`, a readonly `href` string,
and `request` properties. Other common HTTP methods accept `void` and return
`Promise<unknown>`. Untyped links, external targets, and `getRel` calls without
explicit tuples use those same defaults. Custom methods remain available
through explicit `getRel` tuples.

## Entering Through a Resource URL

To enter the API through an existing resource URL instead of its root, use
`fromHref` with the expected resource type:

```ts
import { fromHref } from "@kewne/restspec";
import type { Checklist } from "../generated/types.js";

const bookmarkLink = fromHref<Checklist>("https://api.example.com/checklists/123");
const checklist = await bookmarkLink.request.get();
```

The resource type is supplied by the caller; it does not validate the response.
Without a resource type argument, the GET response type is `unknown`.

## Generated Module Reference

The checklist example's generated module includes the following declarations
(the `Root` interface is abbreviated here; the generated interface also includes
the typed `rels` getter described above):

```ts
import type { ApiRoot, Link, Methods } from "@kewne/restspec";

export interface Root {
   properties: { [key: string]: unknown };
   getRel<METHODS extends Methods = {}>(rel: string): Link<METHODS>[];
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

Both `fromRoot(root, env, options)` and `fromHref(href, options)` accept bearer
credentials. A single token is scoped to the entrypoint's origin, including
its scheme and port, and is reused for same-origin discovered links:

```ts
const rootLink = fromRoot(apiRoot, "production", {
   credentials: { type: "bearer", token: accessToken },
});
```

For APIs spanning multiple domains, supply a credentials map:

```ts
const rootLink = fromRoot(apiRoot, "production", {
   credentials: {
      "https://api.example.com": { type: "bearer", token: apiToken },
      "files.example.com": { type: "bearer", token: filesToken },
   },
});
```

Each link selects credentials by exact origin, then host (including port), then
hostname. URL keys are normalized to their origin. Hostname keys apply across
schemes and ports; prefer HTTPS origin keys for narrowly scoped credentials.
Discovered links retain the configuration but send `Authorization: Bearer ...`
only when their destination matches. Unconfigured destinations receive no
authorization header. No wildcard or subdomain matching is performed.

[Return to the overview](../README.md).
