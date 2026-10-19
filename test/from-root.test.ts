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
