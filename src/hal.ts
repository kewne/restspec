import type { Link, Methods } from "./base-types.js";

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

function normalizeHalLinks(value: unknown, createLink: LinkFactory): Link<Methods>[] {
    const items = Array.isArray(value) ? value : [value];
    const links: Link<Methods>[] = [];
    for (const item of items) {
        if (isHalLink(item)) {
            const name = typeof item.name === "string" ? item.name : undefined;
            const title = typeof item.title === "string" ? item.title : undefined;
            links.push(createLink(item.href, name, title) as unknown as Link<Methods>);
        }
    }
    return links;
}

export function parseHalResource<RESOURCE>(body: unknown, createLink: LinkFactory): RESOURCE {
    if (!isRecord(body)) {
        return {
            properties: body,
            getRel: <METHODS extends Methods = {}>(): Link<METHODS>[] => [],
            get rels() {
                return {};
            },
        } as unknown as RESOURCE;
    }

    const { _links, _embedded: _ignoredEmbedded, ...properties } = body;
    const linksByRel = new Map<string, Link<Methods>[]>();
    const relsObject: Record<string, Record<string, Link<Methods>>> = {};

    if (isRecord(_links)) {
        for (const [rel, rawLinks] of Object.entries(_links)) {
            const parsedLinks = normalizeHalLinks(rawLinks, createLink);
            linksByRel.set(rel, parsedLinks);
            const namedLinks: Record<string, Link<Methods>> = {};
            for (const link of parsedLinks) {
                if (link.name !== undefined) {
                    namedLinks[link.name] = link;
                }
            }
            relsObject[rel] = namedLinks;
        }
    }

    return {
        properties,
        getRel<METHODS extends Methods = {}>(rel: string): Link<METHODS>[] {
            return (linksByRel.get(rel) ?? []) as unknown as Link<METHODS>[];
        },
        get rels() {
            return relsObject;
        },
    } as unknown as RESOURCE;
}
