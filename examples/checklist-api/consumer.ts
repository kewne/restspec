import {createHttpClient, fromHref, fromRoot} from '../../src/base-types.js'
import * as types from '../../generated/types.js'

const client = createHttpClient()

async function accessFromRoot() {
    
    const rootLink = fromRoot(types.root, 'local')
    
    const root = await client.get(rootLink)
    
    const checklistLinks = root.getNamedLink('create', 'checklists')
    
    if (checklistLinks) {
        await client.post(checklistLinks, {
            title: 'My new checklist'
        })
    }
}

async function accessFromBookmark() {
    const checklistLink = fromHref<types.Checklist>('https://example.com/checklist/1')
    
    const checklist = await client.get(checklistLink)
    const editLink = checklist.getNamedLink('edit', 'checklist')
    if (editLink) {
        await client.put(editLink, {
            title: 'Another checklist',
            items: checklist.properties.items
        })
    }
}

async function typeSafeAccess() {
    const root = await client.get(fromRoot(types.root, 'local'));
    const checklistsLink = root.getNamedLink('related', 'checklists')
    if (checklistsLink) {
        const list = await client.get(checklistsLink);
    }

    const createLink = root.getNamedLink('create', 'checklists')
    if (createLink) {
        await client.post(createLink, {
            'title': 'My New Checklist'
        })
    }
}
