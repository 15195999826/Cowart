// Page folders (FORK.md 页的文件夹): the page menu shows the canvas's pages as a tree, since
// one canvas carries every session's pages (50 of them on 2026-10-22, in one long list). A
// page's folder is a path on the page record itself (meta.cowartFolder, the folder names
// joined with "/": 数码宝贝/参考), so it saves and syncs with the page and every host sees
// it; a folder is there while a page is in it. Pages go into folders by sessions only, when
// the user asks (the user chose that over sorting them in the menu): move_cowart_pages here,
// `cowart folder` for Claude, and a folder for the page a session opens. A folder is no page's
// content, so a session sorts pages other sessions are responsible for as well.
export const MOVE_PAGES_TOOL = 'move_cowart_pages'
export const FOLDER_KEY = 'cowartFolder'

const MAX_FOLDER_NAME = 80

// "数码宝贝 / 参考/" → "数码宝贝/参考"; "", "/" and nothing → "" (the top level).
export function normalizeFolder(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error('文件夹要写成文字，比如 数码宝贝/参考。')
  const names = value.split(/[/\\／]/).map((name) => name.trim()).filter(Boolean)
  const long = names.find((name) => name.length > MAX_FOLDER_NAME)
  if (long) throw new Error(`文件夹名「${long.slice(0, 20)}…」太长了（最多 ${MAX_FOLDER_NAME} 个字）。`)
  return names.join('/')
}

export function folderOf(page) {
  try {
    return normalizeFolder(page?.meta?.[FOLDER_KEY])
  } catch {
    return ''
  }
}

// The page record in that folder ("" takes it out of any).
export function withFolder(page, folder) {
  const meta = { ...(page.meta ?? {}) }
  if (folder) meta[FOLDER_KEY] = folder
  else delete meta[FOLDER_KEY]
  return { ...page, meta }
}

const inFolder = (folder, root) => folder === root || folder.startsWith(`${root}/`)

export const MOVE_PAGES_TOOL_DEFINITION = {
  name: MOVE_PAGES_TOOL,
  title: 'Move Cowart Pages',
  description:
    "Sort the canvas's pages into folders, which the page menu shows as a tree (folders nest: 数码宝贝/参考). Either pages (names or page:… ids) go into folder, or with fromFolder that whole folder, its pages and subfolders, moves to folder (renaming it: fromFolder 数码宝贝/参考, folder 数码宝贝/资料). folder \"\" or \"/\" is the top level. A folder exists while a page is in it, so there is nothing to create or delete. Only when the user asks: sorting moves pages other sessions are responsible for too, and changes nothing on any page.",
  inputSchema: {
    type: 'object',
    properties: {
      folder: { type: 'string', description: 'Folder to put them in, names joined with "/" (数码宝贝/参考); "" or "/" for the top level.' },
      pages: { type: 'array', items: { type: 'string' }, description: 'Pages to move, by name or page:… id.' },
      fromFolder: { type: 'string', description: 'Move this folder, with everything in it, to folder (instead of pages).' }
    },
    required: ['folder']
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}

function findPage(pages, ref) {
  const wanted = String(ref ?? '').trim()
  if (!wanted) throw new Error('页名不能为空。')
  const byId = pages.find((page) => page.id === wanted)
  if (byId) return byId
  for (const same of [(page) => page.name === wanted, (page) => page.name.toLowerCase() === wanted.toLowerCase()]) {
    const found = pages.filter(same)
    if (found.length > 1) throw new Error(`叫「${wanted}」的页有 ${found.length} 个（${found.map((page) => page.id).join('、')}），用 id 说是哪一个。`)
    if (found.length === 1) return found[0]
  }
  throw new Error(`画布上没有叫「${wanted}」的页。`)
}

// What move_cowart_pages does to the stored pages: { folder, from, changed: [page records],
// moves: [{ id, name, from, to }], already: [{ id, name }] }.
export function planPageMoves(pages, args = {}) {
  if (args.folder === undefined || args.folder === null) throw new Error('要给 folder：放进哪个文件夹（顶层写 "/"）。')
  const folder = normalizeFolder(args.folder)
  const hasPages = Array.isArray(args.pages) && args.pages.length > 0
  const hasFrom = typeof args.fromFolder === 'string' && args.fromFolder.trim() !== ''
  if (hasPages === hasFrom) throw new Error(hasPages ? 'pages 和 fromFolder 只给一个：挪这些页，或者挪整个文件夹。' : '要给 pages（挪哪些页）或 fromFolder（挪哪个文件夹）。')

  let targets
  let from = null
  if (hasFrom) {
    from = normalizeFolder(args.fromFolder)
    if (!from) throw new Error('fromFolder 不能是顶层：挪顶层的页用 pages。')
    const inside = pages.filter((page) => inFolder(folderOf(page), from))
    if (inside.length === 0) {
      const folders = [...new Set(pages.map(folderOf).filter(Boolean))]
      throw new Error(`没有叫「${from}」的文件夹${folders.length > 0 ? `（现有：${folders.join('、')}）` : '（画布上还没有文件夹）'}。`)
    }
    targets = inside.map((page) => ({ page, to: folderOf(page) === from ? folder : [folder, folderOf(page).slice(from.length + 1)].filter(Boolean).join('/') }))
  } else {
    const seen = new Set()
    targets = args.pages.map((ref) => findPage(pages, ref)).filter((page) => !seen.has(page.id) && seen.add(page.id)).map((page) => ({ page, to: folder }))
  }

  const changed = []
  const moves = []
  const already = []
  for (const { page, to } of targets) {
    const was = folderOf(page)
    if (was === to) {
      already.push({ id: page.id, name: page.name })
      continue
    }
    changed.push(withFolder(page, to))
    moves.push({ id: page.id, name: page.name, from: was, to })
  }
  return { folder, from, changed, moves, already }
}

// The pages as a tree of { name, path, count, children }: each level's children are its folders
// ({ folder }) and then its pages ({ page }), both in the pages' order on the canvas (a folder
// where its first page is). pages: page records, or listings that carry the folder as folder
// ({ id, name, folder }).
export function pageTree(pages) {
  const root = { name: '', path: '', count: 0, children: [], folders: new Map() }
  for (const page of pages) {
    let node = root
    root.count += 1
    const folder = typeof page.folder === 'string' ? normalizeFolder(page.folder) : folderOf(page)
    for (const name of folder.split('/').filter(Boolean)) {
      let child = node.folders.get(name)
      if (!child) {
        child = { name, path: node.path ? `${node.path}/${name}` : name, count: 0, children: [], folders: new Map() }
        node.folders.set(name, child)
        node.children.push({ folder: child })
      }
      child.count += 1
      node = child
    }
    node.children.push({ page })
  }
  const foldersFirst = (node) => {
    node.children = [...node.children.filter((child) => child.folder), ...node.children.filter((child) => child.page)]
    for (const child of node.children) if (child.folder) foldersFirst(child.folder)
  }
  foldersFirst(root)
  return root
}

// Text lines of the tree for the model: a folder as «数码宝贝/（25 页）», what is in it indented.
export function pageTreeLines(pages, describePage) {
  const lines = []
  const walk = (node, depth) => {
    const indent = '  '.repeat(depth)
    for (const child of node.children) {
      if (child.folder) {
        lines.push(`${indent}${child.folder.name}/（${child.folder.count} 页）`)
        walk(child.folder, depth + 1)
      } else {
        lines.push(`${indent}- ${describePage(child.page)}`)
      }
    }
  }
  walk(pageTree(pages), 0)
  return lines
}

// For an open result: where the opened page is in the page menu, and whether its folder just
// changed.
export function folderWords(opened) {
  if (!opened.page) return ''
  if (opened.pageMovedFrom !== null && opened.pageMovedFrom !== undefined) return opened.pageFolder ? `，放进了文件夹「${opened.pageFolder}」` : '，挪到了页菜单的顶层'
  return opened.pageFolder ? `（在文件夹「${opened.pageFolder}」里）` : ''
}

// For an open result that made a page at the top level while the canvas has folders: which
// they are, so the session sorts the page into the one it plainly belongs to (moveHow: how its
// host says the move, with <文件夹> in it). Null otherwise.
export function newPageFolderHint(opened, moveHow) {
  if (!opened.pageCreated || opened.pageFolder) return null
  // Every folder, those holding only folders too (项目 for 项目/数码宝贝).
  const paths = (folder) => folder.split('/').map((_, index, names) => names.slice(0, index + 1).join('/'))
  const folders = [...new Set((opened.pages ?? []).flatMap((page) => (page.folder ? paths(page.folder) : [])))].sort((a, b) => a.localeCompare(b, 'zh'))
  if (folders.length === 0) return null
  const shown = folders.length > 30 ? [...folders.slice(0, 30), `…共 ${folders.length} 个`] : folders
  return `新页在页菜单的顶层。画布上的文件夹：${shown.join('、')}。它明显属于其中一个（同一个项目、同一个主题）就 ${moveHow} 放进去，再告诉用户放在哪；拿不准就留在顶层，别新建文件夹。`
}

export function describeMoves(plan) {
  const where = (folder) => (folder ? `「${folder}」` : '顶层')
  const lines = []
  if (plan.from && !plan.folder) lines.push(`文件夹「${plan.from}」拆掉了，里面的 ${plan.moves.length} 页放到顶层（子文件夹也到了顶层）。`)
  else if (plan.from) lines.push(`文件夹「${plan.from}」挪到了「${plan.folder}」${plan.moves.length > 0 ? `，${plan.moves.length} 页跟着走` : ''}。`)
  else if (plan.moves.length > 0) lines.push(`${plan.moves.length} 页放进了${where(plan.folder)}：`)
  if (!plan.from) for (const move of plan.moves) lines.push(`- 「${move.name}」${move.from ? `（原来在「${move.from}」）` : ''}`)
  if (plan.already.length > 0) lines.push(`本来就在${plan.from ? '那里' : where(plan.folder)}的：${plan.already.map((page) => `「${page.name}」`).join('、')}`)
  if (plan.moves.length === 0 && plan.already.length === 0) lines.push('没有页要挪。')
  lines.push('开着的画布页面几秒内会换上新的页菜单。')
  return lines.join('\n')
}
