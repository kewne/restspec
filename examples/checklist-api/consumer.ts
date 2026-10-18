import {fromHref, fromRoot} from '../../src/base-types.js'
import * as types from '../../generated/types.js'

const rootLink = fromRoot(types.root)

const root = await rootLink.request.get()

const checklistLinks = root.getRel('related')?.find((link) => link.name === 'checklists')

await checklistLinks?.request.post!({
    title: 'My new checklist'
})

// use as a bookmark

const checklistsHref: string = checklistLinks!.href

const newChecklistLinks = fromHref(checklistsHref)

await newChecklistLinks.request.post({
    title: 'Another checklist'
})
