
export type ApiRoot<RootResource> = {
    url: string
    profile: string
    readonly __resourceType?: RootResource
}

export type Methods = {
    [method: string]: [unknown, unknown];
}

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options'

export type Link<TYPES extends Methods = {}> = {
    name: string
    title: string
    readonly href: string
    request: {
        [method in HttpMethod | keyof TYPES]: (reqBody: method extends keyof TYPES ? TYPES[method][0] : unknown) =>
            Promise<method extends keyof TYPES ? TYPES[method][1] : unknown>
    }
}

export function fromRoot<RESOURCE>(root: ApiRoot<RESOURCE>): Link<{ get: [void, RESOURCE] }> {
    return {} as unknown as Link<{ get: [void, RESOURCE] }>
}

export function fromHref<RESOURCE>(href: string): Link<{ get: [void, RESOURCE] }> {
    return {} as unknown as Link<{ get: [void, RESOURCE] }>
}
