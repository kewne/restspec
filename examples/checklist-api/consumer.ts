import {createHttpClient, fromHref, fromRoot} from '../../src/base-types.js'
import * as types from '../../generated/types.js'

const client = createHttpClient()

async function accessFromRoot() {
    
    const rootLink = fromRoot(types.root, 'local')
    
    const root = await client.get(rootLink)
    
    const checklistLinks = root.getRel<{ post: [{ title: string }, types.Checklist] }>('create')?.find((link) => link.name === 'checklists')
    
    if (checklistLinks) {
        await client.post(checklistLinks, {
            title: 'My new checklist'
        })
    }
}

async function accessFromBookmark() {
    const checklistLink = fromHref<types.Checklist>('https://example.com/checklist/1')
    
    const checklist = await client.get(checklistLink)
    const createLink = checklist.getRel<{ post: [{ title: string }, types.Checklist] }>('create')[0]
    if (createLink) {
        await client.post(createLink, {
            title: 'Another checklist'
        })
    }
}

async function typeSafeAccess() {
    const root = await client.get(fromRoot(types.root, 'local'));
    const list = await client.get(root.rels.related.checklists);
    await client.post(root.rels.create.checklists, {
        'title': 'My New Checklist'
    })
}
