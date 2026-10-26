import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, onTestFinished, test } from "vitest";
import { type ApiRoot, type CredentialsMap, fromHref, fromRoot, type Link, type Methods } from "../src/base-types.js";
import { parseHalResource } from "../src/hal.js";

interface TestSubscription {
  properties: {
    status: "ACTIVE" | "INACTIVE";
  };
  getRel<METHODS extends Methods>(rel: string): Link<METHODS>[];
  get rels(): Record<string, never>;
}

interface TestRoot {
  properties: {
    version: string;
  };
  getRel<METHODS extends Methods>(rel: string): Link<METHODS>[];
  get rels(): {
    get related(): {
      get subscription(): Link<{ get: [void, TestSubscription] }>;
    };
  };
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
});

test("fromRoot request.get fetches HAL resource, populates properties, getRel, and rels, and follows child links", async () => {
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

  const rootResource = await fromRoot(apiRoot, "local").request.get();

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

  const subscriptionLink = rootResource.rels.related.subscription;
  expect(subscriptionLink.name).toBe("subscription");
  expect(subscriptionLink.title).toBe("User Subscription");
  expect(subscriptionLink.href).toBe(`${baseUrl}/subscription`);

  const subscription = await subscriptionLink.request.get();
  expect(subscription.properties).toEqual({ status: "ACTIVE" });
});

test("fromRoot request.get throws an error on non-OK HTTP responses", async () => {
  const baseUrl = await startTestServer((_req, res) => {
    res.statusCode = 503;
    res.statusMessage = "Service Unavailable";
    res.end();
  });

  const apiRoot: ApiRoot<TestRoot, { local: string }> = {
    env: { local: `${baseUrl}/failing` },
    profile: "https://example.com/profiles/root",
  };

  await expect(fromRoot(apiRoot, "local").request.get()).rejects.toThrow(
    `${baseUrl}/failing: HTTP 503 Service Unavailable`,
  );
});

test("parseHalResource handles non-object payloads", () => {
  const scalar = parseHalResource<{ properties: string }>("hello", () => {
    throw new Error("should not create links");
  });
  expect(scalar.properties).toBe("hello");
});

const standardMethods = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const bodyMethods = ["post", "put", "patch", "delete", "options"] as const;
type BodyMethods = { [method in typeof bodyMethods[number]]: [unknown, TestRoot] };

test.each(standardMethods)("request.%s sends the verb, credentials, and Accept without an implicit body", async (method) => {
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

  const result = await fromHref(baseUrl, {
    credentials: { type: "bearer", token: "method-token" },
  }).request[method]();

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

test.each(bodyMethods)("request.%s serializes supplied JSON payloads", async (method) => {
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
    const resource = await link.request[method](payload);
    expect(resource.properties).toEqual({ version: "2.0.0" });
  }

  expect(requests).toEqual(payloads.map((payload) => ({
    body: payload === undefined ? "" : JSON.stringify(payload),
    contentType: payload === undefined ? undefined : "application/json",
    method: method.toUpperCase(),
  })));
});

test.each(standardMethods)("request.%s returns undefined for successful empty responses", async (method) => {
  const baseUrl = await startTestServer((req, res) => {
    res.statusCode = Number(req.url!.slice(1));
    res.end();
  });

  for (const status of [200, 204, 205]) {
    await expect(fromHref(`${baseUrl}/${status}`).request[method]()).resolves.toBeUndefined();
  }
});

test.each(["get", "head"] as const)("request.%s does not send a body even with an explicit request tuple", async (method) => {
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

  await expect(fromRoot(apiRoot, "local").request[method]({ title: "ignored" })).resolves.toBeUndefined();
  expect(receivedBody).toBe("");
  expect(contentType).toBeUndefined();
});

test.each(standardMethods)("request.%s rejects HTTP errors before handling an empty body", async (method) => {
  const baseUrl = await startTestServer((_req, res) => {
    res.statusCode = 503;
    res.statusMessage = "Service Unavailable";
    res.end();
  });

  await expect(fromHref(baseUrl).request[method]()).rejects.toThrow(
    `${baseUrl}: HTTP 503 Service Unavailable`,
  );
});

test.each(["not json", " "])("nonempty invalid JSON %j is not treated as an empty response", async (body) => {
  const baseUrl = await startTestServer((_req, res) => res.end(body));
  await expect(fromHref(baseUrl).request.post()).rejects.toThrow(SyntaxError);
});

test("JSON null is parsed as a resource rather than an empty response", async () => {
  const baseUrl = await startTestServer((_req, res) => res.end("null"));
  await expect(fromHref(baseUrl).request.post()).resolves.toMatchObject({ properties: null });
});

test.each([false, true])("non-GET HAL navigation resolves relative links and scopes credentials (map: %s)", async (useMap) => {
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
  const resource = await fromRoot(apiRoot, "local", {
    credentials: useMap ? {
      [baseUrl]: credentials,
      [externalUrl]: { type: "bearer", token: "external-token" },
    } : credentials,
  }).request.post();

  const child = resource.rels.related.subscription;
  expect(child.href).toBe(`${baseUrl}/api/child`);
  expect(child.name).toBe("subscription");
  expect(child.title).toBe("User Subscription");
  await child.request.patch();
  await resource.getRel<{ delete: [void, unknown] }>("external")[0]!.request.delete();
  expect(requests).toEqual([
    { method: "POST", authorization: "Bearer root-token", url: "/api/root" },
    { method: "PATCH", authorization: "Bearer root-token", url: "/api/child" },
    { method: "DELETE", authorization: useMap ? "Bearer external-token" : undefined, url: "/" },
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
])("fromHref selects credentials by %s", async (match, expected) => {
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

  await fromHref(baseUrl, { credentials: maps[match] }).request.get();
  expect(authorization).toBe(expected);
});

test.each([false, true])("HAL navigation scopes credentials to each destination (map: %s)", async (useMap) => {
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
  const resource = await fromRoot(apiRoot, "local", {
    credentials: useMap ? {
      [baseUrl]: credentials,
      [externalUrl]: { type: "bearer", token: "external-token" },
    } : credentials,
  }).request.get();

  expect(resource.rels.related.subscription.href).toBe(`${baseUrl}/subscription`);
  await resource.rels.related.subscription.request.get();
  await resource.getRel<{ get: [void, unknown] }>("external")[0]!.request.get();
  expect(requests).toEqual([
    "Bearer root-token",
    "Bearer root-token",
    useMap ? "Bearer external-token" : undefined,
  ]);
});
