import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, onTestFinished, test } from "vitest";
import { type ApiRoot, createHttpClient, createLink, type CredentialsMap, fromHref, fromRoot, type Link } from "../src/base-types.js";
import { parseHalResource } from "../src/hal.js";

const client = createHttpClient();

interface TestSubscription {
  properties: {
    status: "ACTIVE" | "INACTIVE";
  };
  getRel(rel: string): Link[];
  getNamedLink(rel: string, name: string): Link | undefined;
}

interface TestRoot {
  properties: {
    version: string;
  };
  getRel(rel: "related"): Link[];
  getRel(rel: string): Link[];
  getNamedLink(rel: "related", name: "subscription"): Link<{ get: [void, TestSubscription] }> | undefined;
  getNamedLink(rel: string, name: string): Link | undefined;
}

async function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

test("fromRoot returns a Link for the selected environment with optional name and title", () => {
  const apiRoot: ApiRoot<TestRoot, { local: string; production: string }> = {
    env: {
      local: "http://localhost:3000/api",
      production: "https://example.com/api",
    },
    profile: "https://example.com/profiles/root",
  };

  const link = fromRoot(apiRoot, "local");
  expect(link.href).toBe("http://localhost:3000/api");
  expect(link.name).toBeUndefined();
  expect(link.title).toBeUndefined();
  expect(Object.keys(link)).toEqual(["href"]);
  expect(link).not.toHaveProperty("request");
  expect(link).not.toHaveProperty("__methodTypes");
});

test("client.get fetches HAL resource, populates properties and links, and follows named links", async () => {
  const receivedHeaders: Record<string, string | string[] | undefined>[] = [];
  const baseUrl = await startTestServer((req, res) => {
    receivedHeaders.push(req.headers);
    res.setHeader("Content-Type", "application/hal+json");
    if (req.url === "/root") {
      res.end(
        JSON.stringify({
          version: "1.0.0",
          _embedded: {
            ignored: { foo: "bar" },
          },
          _links: {
            self: { href: `${baseUrl}/root` },
            related: [
              {
                name: "subscription",
                title: "User Subscription",
                href: `${baseUrl}/subscription`,
              },
              {
                name: "checklists",
                href: `${baseUrl}/checklists`,
              },
            ],
          },
        }),
      );
      return;
    }
    if (req.url === "/subscription") {
      res.end(
        JSON.stringify({
          status: "ACTIVE",
          _links: {
            self: { href: `${baseUrl}/subscription` },
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const apiRoot: ApiRoot<TestRoot, { local: string }> = {
    env: { local: `${baseUrl}/root` },
    profile: "https://example.com/profiles/root",
  };

  const rootResource = await client.get(fromRoot(apiRoot, "local"));

  expect(receivedHeaders[0]?.accept).toBe("application/hal+json, application/json");
  expect(rootResource.properties).toEqual({ version: "1.0.0" });

  const selfLinks = rootResource.getRel("self");
  expect(selfLinks).toHaveLength(1);
  expect(selfLinks[0]?.href).toBe(`${baseUrl}/root`);
  expect(selfLinks[0]?.name).toBeUndefined();
  expect(selfLinks[0]?.title).toBeUndefined();

  const relatedLinks = rootResource.getRel("related");
  expect(relatedLinks).toHaveLength(2);
  expect(relatedLinks[0]?.name).toBe("subscription");
  expect(relatedLinks[0]?.title).toBe("User Subscription");
  expect(relatedLinks[0]?.href).toBe(`${baseUrl}/subscription`);

  expect(rootResource.getRel("missing")).toEqual([]);

  const subscriptionLink = rootResource.getNamedLink("related", "subscription");
  expect(subscriptionLink).toBe(relatedLinks[0]);
  expect(rootResource.getNamedLink("missing", "subscription")).toBeUndefined();
  expect(rootResource.getNamedLink("related", "missing")).toBeUndefined();
  expect(rootResource.getNamedLink("self", "")).toBeUndefined();
  expect(rootResource).not.toHaveProperty("rels");
  if (!subscriptionLink) throw new Error("Missing subscription link");
  expect(subscriptionLink.name).toBe("subscription");
  expect(subscriptionLink.title).toBe("User Subscription");
  expect(subscriptionLink.href).toBe(`${baseUrl}/subscription`);

  expect(subscriptionLink).not.toHaveProperty("request");
  const subscription = await client.get(subscriptionLink);
  expect(subscription.properties).toEqual({ status: "ACTIVE" });
});

test("client.get throws an error on non-OK HTTP responses", async () => {
  const baseUrl = await startTestServer((_req, res) => {
    res.statusCode = 503;
    res.statusMessage = "Service Unavailable";
    res.end();
  });

  const apiRoot: ApiRoot<TestRoot, { local: string }> = {
    env: { local: `${baseUrl}/failing` },
    profile: "https://example.com/profiles/root",
  };

  await expect(client.get(fromRoot(apiRoot, "local"))).rejects.toThrow(
    `${baseUrl}/failing: HTTP 503 Service Unavailable`,
  );
});

test.each(["hello", null, [], 42])("parseHalResource handles non-object payload %j", (body) => {
  const scalar = parseHalResource<TestSubscription>(body, () => {
    throw new Error("should not create links");
  });
  expect(scalar.properties).toBe(body);
  expect(scalar.getRel("missing")).toEqual([]);
  expect(scalar.getNamedLink("missing", "missing")).toBeUndefined();
  expect(scalar).not.toHaveProperty("rels");
});

test("named lookup handles duplicate names, invalid links, and prototype-like keys", () => {
  const resource = parseHalResource<TestRoot>({
    _links: {
      related: [
        { href: "/first", name: "duplicate" },
        { href: "/second", name: "duplicate" },
        { href: "/unnamed" },
        { href: "/prototype", name: "__proto__" },
        { name: "invalid" },
        null,
      ],
      ["__proto__"]: { href: "/constructor", name: "constructor" },
      empty: [],
    },
  }, createLink);
  expect(resource.getRel("related")).toHaveLength(4);
  expect(resource.getNamedLink("related", "duplicate")).toBe(resource.getRel("related")[1]);
  expect(resource.getNamedLink("related", "__proto__")?.href).toBe("/prototype");
  expect(resource.getNamedLink("__proto__", "constructor")?.href).toBe("/constructor");
  expect(resource.getNamedLink("related", "constructor")).toBeUndefined();
  expect(resource.getNamedLink("constructor", "constructor")).toBeUndefined();
  expect(resource.getNamedLink("related", "invalid")).toBeUndefined();
  expect(resource.getNamedLink("empty", "anything")).toBeUndefined();
  expect(resource.getRel("empty")).toEqual([]);
});

const standardMethods = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const bodyMethods = ["post", "put", "patch", "delete", "options"] as const;
type BodyMethods = { [method in typeof bodyMethods[number]]: [unknown, TestRoot] };

test.each(standardMethods)("client.%s sends the verb, credentials, and Accept without an implicit body", async (method) => {
  let receivedMethod: string | undefined;
  let receivedHeaders: IncomingMessage["headers"] = {};
  let receivedBody = "";
  const baseUrl = await startTestServer((req, res) => {
    receivedMethod = req.method;
    receivedHeaders = req.headers;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { receivedBody += chunk; });
    req.on("end", () => res.end(JSON.stringify({ version: "2.0.0" })));
  });

  const authenticatedClient = createHttpClient({
    credentials: { [baseUrl]: { type: "bearer", token: "method-token" } },
  });
  const result = await authenticatedClient[method](fromHref(baseUrl));

  expect(receivedMethod).toBe(method.toUpperCase());
  expect(receivedHeaders.accept).toBe("application/hal+json, application/json");
  expect(receivedHeaders.authorization).toBe("Bearer method-token");
  expect(receivedHeaders["content-type"]).toBeUndefined();
  expect(receivedBody).toBe("");
  if (method === "head") {
    expect(result).toBeUndefined();
  } else {
    expect(result).toMatchObject({ properties: { version: "2.0.0" } });
  }
});

test.each(bodyMethods)("client.%s serializes supplied JSON payloads", async (method) => {
  const requests: { body: string; contentType: string | undefined; method: string | undefined }[] = [];
  const baseUrl = await startTestServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      requests.push({ body, contentType: req.headers["content-type"], method: req.method });
      res.end(JSON.stringify({ version: "2.0.0" }));
    });
  });
  const apiRoot: ApiRoot<TestRoot, { local: string }, BodyMethods> = {
    env: { local: baseUrl },
    profile: "https://example.test/profiles/root",
  };
  const link = fromRoot(apiRoot, "local");
  const payloads = [{ title: "New checklist", items: [] }, false, 0, "", null, undefined];

  for (const payload of payloads) {
    const resource = await client[method](link, payload);
    expect(resource.properties).toEqual({ version: "2.0.0" });
  }

  expect(requests).toEqual(payloads.map((payload) => ({
    body: payload === undefined ? "" : JSON.stringify(payload),
    contentType: payload === undefined ? undefined : "application/json",
    method: method.toUpperCase(),
  })));
});

test.each(standardMethods)("client.%s returns undefined for successful empty responses", async (method) => {
  const baseUrl = await startTestServer((req, res) => {
    res.statusCode = Number(req.url!.slice(1));
    res.end();
  });

  for (const status of [200, 204, 205]) {
    await expect(client[method](fromHref(`${baseUrl}/${status}`))).resolves.toBeUndefined();
  }
});

test.each(["get", "head"] as const)("client.%s does not send a body even with an explicit request tuple", async (method) => {
  let receivedBody = "";
  let contentType: string | undefined;
  const baseUrl = await startTestServer((req, res) => {
    contentType = req.headers["content-type"];
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { receivedBody += chunk; });
    req.on("end", () => res.end());
  });
  const apiRoot: ApiRoot<TestRoot, { local: string }, {
    get: [{ title: string }, TestRoot];
    head: [{ title: string }, TestRoot];
  }> = {
    env: { local: baseUrl },
    profile: "https://example.test/profiles/root",
  };

  await expect(client[method](fromRoot(apiRoot, "local"), { title: "ignored" })).resolves.toBeUndefined();
  expect(receivedBody).toBe("");
  expect(contentType).toBeUndefined();
});

test.each(standardMethods)("client.%s rejects HTTP errors before handling an empty body", async (method) => {
  const baseUrl = await startTestServer((_req, res) => {
    res.statusCode = 503;
    res.statusMessage = "Service Unavailable";
    res.end();
  });

  await expect(client[method](fromHref(baseUrl))).rejects.toThrow(
    `${baseUrl}: HTTP 503 Service Unavailable`,
  );
});

test.each(["not json", " "])("nonempty invalid JSON %j is not treated as an empty response", async (body) => {
  const baseUrl = await startTestServer((_req, res) => res.end(body));
  await expect(client.post(fromHref(baseUrl))).rejects.toThrow(SyntaxError);
});

test("JSON null is parsed as a resource rather than an empty response", async () => {
  const baseUrl = await startTestServer((_req, res) => res.end("null"));
  await expect(client.post(fromHref(baseUrl))).resolves.toMatchObject({ properties: null });
});

test.each([false, true])("non-GET HAL navigation resolves relative links and scopes credentials (external configured: %s)", async (configureExternal) => {
  const requests: { method: string | undefined; authorization: string | undefined; url: string | undefined }[] = [];
  const externalUrl = await startTestServer((req, res) => {
    requests.push({ method: req.method, authorization: req.headers.authorization, url: req.url });
    res.end("{}");
  });
  const baseUrl = await startTestServer((req, res) => {
    requests.push({ method: req.method, authorization: req.headers.authorization, url: req.url });
    res.end(JSON.stringify({
      version: "2.0.0",
      _links: {
        related: { href: "child", name: "subscription", title: "User Subscription" },
        external: { href: externalUrl },
      },
    }));
  });
  const apiRoot: ApiRoot<TestRoot, { local: string }, { post: [void, TestRoot] }> = {
    env: { local: `${baseUrl}/api/root` },
    profile: "https://example.test/profiles/root",
  };
  const credentials = { type: "bearer", token: "root-token" } as const;
  const authenticatedClient = createHttpClient({
    credentials: {
      [baseUrl]: credentials,
      ...(configureExternal ? { [externalUrl]: { type: "bearer" as const, token: "external-token" } } : {}),
    },
  });
  const resource = await authenticatedClient.post(fromRoot(apiRoot, "local"));

  const child = resource.getNamedLink("related", "subscription");
  if (!child) throw new Error("Missing subscription link");
  expect(child.href).toBe(`${baseUrl}/api/child`);
  expect(child.name).toBe("subscription");
  expect(child.title).toBe("User Subscription");
  await authenticatedClient.patch(child);
  await authenticatedClient.delete(resource.getRel("external")[0]!);
  expect(requests).toEqual([
    { method: "POST", authorization: "Bearer root-token", url: "/api/root" },
    { method: "PATCH", authorization: "Bearer root-token", url: "/api/child" },
    { method: "DELETE", authorization: configureExternal ? "Bearer external-token" : undefined, url: "/" },
  ]);
});

test.each([
  ["origin", "Bearer origin-token"],
  ["host", "Bearer host-token"],
  ["hostname", "Bearer hostname-token"],
  ["URL with trailing slash", "Bearer origin-token"],
  ["precedence", "Bearer origin-token"],
  ["host precedence", "Bearer host-token"],
  ["unmatched", undefined],
  ["absent", undefined],
])("client selects credentials by %s", async (match, expected) => {
  let authorization: string | undefined;
  const baseUrl = await startTestServer((req, res) => {
    authorization = req.headers.authorization;
    res.end("{}");
  });
  const url = new URL(baseUrl);
  const originToken = { type: "bearer", token: "origin-token" } as const;
  const hostToken = { type: "bearer", token: "host-token" } as const;
  const hostnameToken = { type: "bearer", token: "hostname-token" } as const;
  const maps: Record<string, CredentialsMap> = {
    origin: { [url.origin]: originToken },
    host: { [url.host]: hostToken },
    hostname: { [url.hostname]: hostnameToken },
    "URL with trailing slash": { [`${url.origin}/`]: originToken },
    precedence: { [url.hostname]: hostnameToken, [url.host]: hostToken, [url.origin]: originToken },
    "host precedence": { [url.hostname]: hostnameToken, [url.host]: hostToken },
    unmatched: { "example.test": originToken },
  };

  await createHttpClient({ credentials: maps[match] }).get(fromHref(baseUrl));
  expect(authorization).toBe(expected);
});

test.each([false, true])("HAL navigation scopes credentials to each destination (external configured: %s)", async (configureExternal) => {
  const requests: (string | undefined)[] = [];
  const externalUrl = await startTestServer((req, res) => {
    requests.push(req.headers.authorization);
    res.end("{}");
  });
  const baseUrl = await startTestServer((req, res) => {
    requests.push(req.headers.authorization);
    res.end(JSON.stringify({
      version: "1.0.0",
      _links: {
        related: { href: "/subscription", name: "subscription" },
        external: { href: externalUrl },
      },
    }));
  });
  const credentials = { type: "bearer", token: "root-token" } as const;
  const apiRoot: ApiRoot<TestRoot, { local: string }> = {
    env: { local: `${baseUrl}/root` },
    profile: "https://example.test/profiles/root",
  };
  const authenticatedClient = createHttpClient({
    credentials: {
      [baseUrl]: credentials,
      ...(configureExternal ? { [externalUrl]: { type: "bearer" as const, token: "external-token" } } : {}),
    },
  });
  const resource = await authenticatedClient.get(fromRoot(apiRoot, "local"));

  const subscription = resource.getNamedLink("related", "subscription");
  if (!subscription) throw new Error("Missing subscription link");
  expect(subscription.href).toBe(`${baseUrl}/subscription`);
  await authenticatedClient.get(subscription);
  await authenticatedClient.get(resource.getRel("external")[0]!);
  expect(requests).toEqual([
    "Bearer root-token",
    "Bearer root-token",
    configureExternal ? "Bearer external-token" : undefined,
  ]);
});

test("credentials belong to clients rather than links", async () => {
  const authorizations: (string | undefined)[] = [];
  const baseUrl = await startTestServer((req, res) => {
    authorizations.push(req.headers.authorization);
    res.end("{}");
  });
  const link = fromHref(baseUrl);
  const firstClient = createHttpClient({
    credentials: { [baseUrl]: { type: "bearer", token: "first-token" } },
  });
  const secondClient = createHttpClient({
    credentials: { [baseUrl]: { type: "bearer", token: "second-token" } },
  });

  await firstClient.get(link);
  await secondClient.get(link);
  await client.get(link);

  expect(authorizations).toEqual(["Bearer first-token", "Bearer second-token", undefined]);
  expect(Object.keys(link)).toEqual(["href"]);
});

test("HAL relative links resolve against the final response URL after a redirect", async () => {
  const baseUrl = await startTestServer((req, res) => {
    if (req.url === "/entry") {
      res.writeHead(302, { Location: "/api/root" });
      res.end();
    } else {
      res.end(JSON.stringify({ _links: { related: { href: "child", name: "subscription" } } }));
    }
  });

  const resource = await client.get(fromHref<TestRoot>(`${baseUrl}/entry`));
  expect(resource.getNamedLink("related", "subscription")?.href).toBe(`${baseUrl}/api/child`);
});
