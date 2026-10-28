import type { Link } from "./base-types.js";

export type HalLink = {
    href: string;
    name?: string;
    title?: string;
    [key: string]: unknown;
};

export type HalResource = {
    _links?: Record<string, HalLink | readonly HalLink[]>;
    _embedded?: Record<string, unknown>;
    [key: string]: unknown;
};

export type LinkFactory = <RESOURCE = unknown>(
    href: string,
    name?: string,
    title?: string,
) => Link<{ get: [void, RESOURCE] }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHalLink(value: unknown): value is HalLink {
    return isRecord(value) && typeof value.href === "string";
}

function normalizeHalLinks(value: unknown, createLink: LinkFactory): Link[] {
    const items = Array.isArray(value) ? value : [value];
    const links: Link[] = [];
    for (const item of items) {
        if (isHalLink(item)) {
            const name = typeof item.name === "string" ? item.name : undefined;
            const title = typeof item.title === "string" ? item.title : undefined;
            links.push(createLink(item.href, name, title));
        }
    }
    return links;
}

export function parseHalResource<RESOURCE>(body: unknown, createLink: LinkFactory): RESOURCE {
    if (!isRecord(body)) {
        return {
            properties: body,
            getRel: (): Link[] => [],
            getNamedLink: (): Link | undefined => undefined,
        } as unknown as RESOURCE;
    }

    const { _links, _embedded: _ignoredEmbedded, ...properties } = body;
    const linksByRel = new Map<string, Link[]>();
    const namedLinksByRel = new Map<string, Map<string, Link>>();

    if (isRecord(_links)) {
        for (const [rel, rawLinks] of Object.entries(_links)) {
            const parsedLinks = normalizeHalLinks(rawLinks, createLink);
            linksByRel.set(rel, parsedLinks);
            const namedLinks = new Map<string, Link>();
            for (const link of parsedLinks) {
                if (link.name !== undefined) {
                    namedLinks.set(link.name, link);
                }
            }
            namedLinksByRel.set(rel, namedLinks);
        }
    }

    return {
        properties,
        getRel(rel: string): Link[] {
            return linksByRel.get(rel) ?? [];
        },
        getNamedLink(rel: string, name: string): Link | undefined {
            return namedLinksByRel.get(rel)?.get(name);
        },
    } as unknown as RESOURCE;
}
