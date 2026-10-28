
import { parseHalResource } from "./hal.js"

export type ApiRoot<RootResource, ENV extends Record<string, string> = Record<string, string>, ROOT_METHODS extends Methods = { get: [void, RootResource] }> = {
    env: ENV
    profile: string
    readonly __resourceType?: RootResource
    readonly __methodTypes?: ROOT_METHODS
}

export type Methods = {
    [method: string]: [unknown, unknown];
}

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options'

export type BearerCredentials = { type: 'bearer'; token: string }
export type Credentials = BearerCredentials
export type CredentialsMap = Readonly<Record<string, Credentials>>
export type ClientOptions = { credentials?: CredentialsMap }

function normalizeCredentials(credentials?: CredentialsMap): CredentialsMap | undefined {
    if (credentials === undefined) return undefined
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
    readonly __methodTypes?: TYPES
}

type RequestArguments<BODY> = void extends BODY
    ? unknown extends BODY ? [reqBody: BODY] : [reqBody?: BODY]
    : [reqBody: BODY]

export type HttpClient = {
    [method in HttpMethod]: <TYPES extends Methods>(
        link: Link<TYPES>,
        ...args: NoInfer<RequestArguments<method extends keyof TYPES ? TYPES[method][0] : void>>
    ) => Promise<method extends keyof TYPES ? TYPES[method][1] : unknown>
}

export function createHttpClient(options?: ClientOptions): HttpClient {
    const credentialsMap = normalizeCredentials(options?.credentials)

    async function execute(method: HttpMethod, link: Link, reqBody?: unknown): Promise<unknown> {
        const { href } = link
        const credentials = credentialsForUrl(href, credentialsMap)
        const requestBody = method !== 'get' && method !== 'head' && reqBody !== undefined
            ? JSON.stringify(reqBody) : undefined
        const response = await fetch(href, {
            method: method.toUpperCase(),
            ...(requestBody !== undefined ? { body: requestBody } : {}),
            headers: {
                Accept: "application/hal+json, application/json",
                ...(requestBody !== undefined ? { "Content-Type": "application/json" } : {}),
                ...(credentials?.type === 'bearer'
                    ? { Authorization: `Bearer ${credentials.token}` } : {}),
            },
        })
        if (!response.ok) {
            throw new Error(`${href}: HTTP ${response.status} ${response.statusText}`)
        }
        if (method === 'head' || response.status === 204 || response.status === 205) return undefined
        const responseText = await response.text()
        if (responseText.length === 0) return undefined
        const body: unknown = JSON.parse(responseText)
        return parseHalResource(body, (childHref, childName, childTitle) =>
            createLink(new URL(childHref, response.url || href).href, childName, childTitle))
    }

    return {
        get: (link: Link, reqBody?: unknown) => execute('get', link, reqBody),
        post: (link: Link, reqBody?: unknown) => execute('post', link, reqBody),
        put: (link: Link, reqBody?: unknown) => execute('put', link, reqBody),
        patch: (link: Link, reqBody?: unknown) => execute('patch', link, reqBody),
        delete: (link: Link, reqBody?: unknown) => execute('delete', link, reqBody),
        head: (link: Link, reqBody?: unknown) => execute('head', link, reqBody),
        options: (link: Link, reqBody?: unknown) => execute('options', link, reqBody),
    } as HttpClient
}

export function createLink<RESOURCE = unknown>(
    href: string,
    name?: string,
    title?: string,
): Link<{ get: [void, RESOURCE] }> {
    return {
        ...(name !== undefined ? { name } : {}),
        ...(title !== undefined ? { title } : {}),
        get href() {
            return href
        },
    }
}

export function fromRoot<RESOURCE, ENV extends Record<string, string>, ROOT_METHODS extends Methods = { get: [void, RESOURCE] }>(root: ApiRoot<RESOURCE, ENV, ROOT_METHODS>, env: keyof ENV & string): Link<ROOT_METHODS> {
    return fromHref<RESOURCE>(root.env[env]!) as unknown as Link<ROOT_METHODS>
}

export function fromHref<RESOURCE = unknown>(href: string): Link<{ get: [void, RESOURCE] }> {
    return createLink<RESOURCE>(href)
}
