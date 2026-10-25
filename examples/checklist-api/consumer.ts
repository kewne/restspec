import {fromHref, fromRoot} from '../../src/base-types.js'
import * as types from '../../generated/types.js'

async function accessFromRoot() {
    
    const rootLink = fromRoot(types.root, 'local')
    
    const root = await rootLink.request.get()
    
    const checklistLinks = root.getRel<{ post: [{ title: string }, types.Checklist] }>('create')?.find((link) => link.name === 'checklists')
    
    await checklistLinks?.request.post!({
        title: 'My new checklist'
    })
}

async function accessFromBookmark() {
    const checklistLink = fromHref<types.Checklist>('https://example.com/checklist/1')
    
    const checklist = await checklistLink.request.get()
    await checklist.getRel<{ post: [{ title: string }, types.Checklist] }>('create')[0]?.request.post({
        title: 'Another checklist'
    })
}

async function typeSafeAccess() {
    const root = await fromRoot(types.root, 'local').request.get();
    const list = await root.rels.related.checklists.request.get();
    await root.rels.create.checklists.request.post({
        'title': 'My New Checklist'
    })
}
