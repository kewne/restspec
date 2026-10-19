
import { parseHalResource } from "./hal.js"

export type ApiRoot<RootResource, ENV extends Record<string, string> = Record<string, string>> = {
    env: ENV
    profile: string
    readonly __resourceType?: RootResource
}

export type Methods = {
    [method: string]: [unknown, unknown];
}

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options'

export type BearerCredentials = { type: 'bearer'; token: string }
export type Credentials = BearerCredentials
export type CredentialsMap = Readonly<Record<string, Credentials>>
export type CredentialsConfig = Credentials | CredentialsMap
export type ClientOptions = { credentials?: CredentialsConfig }

function isSingleCredentials(credentials: CredentialsConfig): credentials is Credentials {
    return credentials.type === 'bearer' && typeof credentials.token === 'string'
}

function normalizeCredentials(href: string, credentials?: CredentialsConfig): CredentialsMap | undefined {
    if (credentials === undefined) return undefined
    if (isSingleCredentials(credentials)) {
        return { [new URL(href).origin]: credentials }
    }
    return Object.fromEntries(Object.entries(credentials).map(([key, value]) => [
        /^https?:\/\//i.test(key) ? new URL(key).origin : key,
        value,
    ]))
}

function credentialsForUrl(href: string, credentials?: CredentialsMap): Credentials | undefined {
    if (credentials === undefined) return undefined
    const url = new URL(href)
    for (const key of [url.origin, url.host, url.hostname]) {
        if (Object.hasOwn(credentials, key)) return credentials[key]
    }
    return undefined
}

export type Link<TYPES extends Methods = {}> = {
    name?: string
    title?: string
    readonly href: string
    request: {
        [method in HttpMethod | keyof TYPES]: (reqBody: method extends keyof TYPES ? TYPES[method][0] : unknown) =>
            Promise<method extends keyof TYPES ? TYPES[method][1] : unknown>
    }
}

export function createLink<RESOURCE = unknown>(
    href: string,
    name?: string,
    title?: string,
    credentialsMap?: CredentialsMap,
): Link<{ get: [void, RESOURCE] }> {
    return {
        ...(name !== undefined ? { name } : {}),
        ...(title !== undefined ? { title } : {}),
        get href() {
            return href
        },
        request: {
            async get(): Promise<RESOURCE> {
                const credentials = credentialsForUrl(href, credentialsMap)
                const response = await fetch(href, {
                    headers: {
                        Accept: "application/hal+json, application/json",
                        ...(credentials?.type === 'bearer'
                            ? { Authorization: `Bearer ${credentials.token}` } : {}),
                    },
                })
                if (!response.ok) {
                    throw new Error(`${href}: HTTP ${response.status} ${response.statusText}`)
                }
                const body: unknown = await response.json()
                return parseHalResource<RESOURCE>(body, (childHref, childName, childTitle) =>
                    createLink(new URL(childHref, response.url || href).href, childName, childTitle, credentialsMap))
            },
        } as Link<{ get: [void, RESOURCE] }>["request"],
    }
}

export function fromRoot<RESOURCE, ENV extends Record<string, string>>(root: ApiRoot<RESOURCE, ENV>, env: keyof ENV & string, options?: ClientOptions): Link<{ get: [void, RESOURCE] }> {
    return fromHref<RESOURCE>(root.env[env]!, options)
}

export function fromHref<RESOURCE = unknown>(href: string, options?: ClientOptions): Link<{ get: [void, RESOURCE] }> {
    return createLink<RESOURCE>(href, undefined, undefined, normalizeCredentials(href, options?.credentials))
}
