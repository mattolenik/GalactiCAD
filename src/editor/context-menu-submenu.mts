/**
 * Add submenus to the Monaco editor context menu.
 *
 * Monaco's public addAction API does not support submenus. This module uses
 * internal MenuRegistry APIs (as documented in
 * https://github.com/microsoft/monaco-editor/issues/1947) to register a
 * submenu and move our actions into it.
 */

import type { IStandaloneCodeEditor } from "monaco-editor"
// @ts-expect-error internal Monaco API
import { LinkedList } from "monaco-editor/esm/vs/base/common/linkedList.js"
// @ts-expect-error internal Monaco API
import { MenuId, MenuRegistry } from "monaco-editor/esm/vs/platform/actions/common/actions.js"

export interface SubmenuActionDescriptor {
    id: string
    label: string
    run: (editor: IStandaloneCodeEditor) => void
}

export interface ContextSubmenuDescriptor {
    /** Submenu title shown in the context menu */
    title: string
    /** VS Code-style group (e.g. "0_shapes", "1_modification") */
    group: string
    /** Order within the group */
    order: number
    /** Actions to show in the submenu */
    actions: SubmenuActionDescriptor[]
}

/**
 * Add a submenu to the editor context menu. Registers each action with the
 * editor and moves them into a submenu entry.
 *
 * @returns A disposable that removes the submenu and its actions when called.
 */
export function addContextSubmenu(
    editor: IStandaloneCodeEditor,
    descriptor: ContextSubmenuDescriptor
): () => void {
    const submenuId = `galacticad.submenu.${descriptor.title.replace(/\s+/g, ".").toLowerCase()}`
    const submenu = new MenuId(submenuId)
    const submenuList = new LinkedList()
    ;(MenuRegistry as { _menuItems: Map<unknown, LinkedList> })._menuItems.set(submenu, submenuList)

    const editorContextItems = (MenuRegistry as { _menuItems: Map<unknown, LinkedList> })._menuItems.get(
        MenuId.EditorContext
    ) as LinkedList

    for (let i = 0; i < descriptor.actions.length; i++) {
        const action = descriptor.actions[i]
        const fullId = `galacticad.${action.id}`

        editor.addAction({
            id: fullId,
            label: action.label,
            run: action.run,
            contextMenuOrder: i,
            contextMenuGroupId: submenuId,
        })

        const actionId = editor
            .getSupportedActions()
            .find((a) => a.label === action.label && a.id.endsWith(action.id))?.id

        if (actionId) {
            const item = popMenuItem(editorContextItems, actionId)
            if (item) {
                submenuList.push(item)
            }
        }
    }

    const submenuEntry = {
        group: descriptor.group,
        order: descriptor.order,
        submenu,
        title: descriptor.title,
    }

    const removeSubmenuEntry = MenuRegistry.appendMenuItem(MenuId.EditorContext, submenuEntry)

    return () => {
        removeSubmenuEntry()
        ;(MenuRegistry as { _menuItems: Map<unknown, LinkedList> })._menuItems.delete(submenu)
    }
}

function popMenuItem(
    items: { _first: { element?: { command?: { id: string } }; next: unknown }; _remove: (n: unknown) => void },
    commandId: string
): unknown {
    let node = items._first
    while (node && node.element !== undefined) {
        if (node.element?.command?.id === commandId) {
            items._remove(node)
            return node.element
        }
        node = node.next as typeof node
    }
    return undefined
}
