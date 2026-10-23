// Claude Code side of the Cowart canvas: the cowart command (bin/cowart.mjs), which sessions run
// with the Bash tool; the cowart skill (skills/cowart) says when and how. The canvas runs in the
// machine-wide canvas service (adapters/service), which serves it on localhost for the Browser
// pane, makes one session at a time responsible for each page and routes a page's requests to
// that session. Each command finds the service (starts it, replaces one running older code),
// makes one call and leaves; `cowart listen`, run in the background, brings the session its
// canvas requests and keeps it online while it runs (server.mjs). It used to be an MCP server,
// registered project by project, and the session was online only while that process lived.
// Codex sessions run the same command (hostFromEnv): their texts link the canvas for Codex's
// built-in browser and run no listener (their requests wait until the user asks, 看画布); their
// canvas page keeps them online while it is open (server.mjs). Codex runs `hook prompt` whenever
// the user sends a message (install.mjs puts it in its hooks.json): it reminds the session of the
// requests waiting for it.
//
// The commands follow what a session does with the canvas, not the tools one by one: open it
// and take pages (open, take, listen), look at it (pages, page, selection), put things on it
// (put image / video / html / text, with one set of placement flags), arrange it (group, edit,
// delete), and answer its requests. `call <tool>` runs any tool with its own parameters, the way
// a canvas request (written for Codex) spells them.
import { readFile } from 'node:fs/promises'

import { CanvasServiceClient, probeService } from '../../service/client.mjs'
import { canvasOwner } from '../../service/lib/canvas-lock.mjs'
import { DEFAULT_PORT, VERSION, compareVersions, samePath } from '../../service/lib/identity.mjs'
import { MOVE_PAGES_TOOL, folderWords, newPageFolderHint, normalizeFolder, pageTreeLines } from '../../service/lib/page-folders.mjs'
import { AGENT_STATUSES, requestTask } from '../../service/lib/requests.mjs'
import { loadOrCreateToken } from '../../service/lib/token.mjs'
import { SHARED_CANVAS_DIR } from '../../shared/paths.mjs'
import { COMMAND_LINK, ENTRY, commandLinkShown, installCowart, linkTarget, removeCowart } from './install.mjs'
import { listenForRequests } from './listen.mjs'
import { ANNOTATION_EDIT_NOTE, ANNOTATION_EDIT_QUESTION, ANNOTATION_REMARKS_NOTE, requestLine, restartListenerNote } from './request-notice.mjs'
import { CANVAS_STATE_TOOL, GET_REQUEST_TOOL, INSERT_VIDEO_TOOL, LIST_REQUESTS_TOOL, OWN_TOOLS, RENDER_TOOL, REPLY_REQUEST_TOOL } from './tools.mjs'

// What `install` writes and where (install.mjs), as this module has always offered them.
export { COMMAND_LINK, ENTRY, installCommandLink, removeCommandLink } from './install.mjs'

// The canvas needs the desktop's Browser pane; other entry points are turned away. Desktop
// builds other than the official one add a suffix to the entry point (the relay build sends
// claude-desktop-3p) and have the same Browser pane, so they count as the desktop too.
const DESKTOP_ENTRYPOINT = 'claude-desktop'

export function isDesktopEntrypoint(entrypoint) {
  return entrypoint === DESKTOP_ENTRYPOINT || String(entrypoint).startsWith(`${DESKTOP_ENTRYPOINT}-`)
}

// The desktop gives the commands a session runs its session id (its Bash tool's environment, as
// it gave its MCP servers): it outlives a resumed session, so the pages it opened reconnect to
// it. Codex gives the commands of a task its thread (CODEX_THREAD_ID; codex-<thread>, as its
// MCP bridge called the session). Tests and the dev host set COWART_SESSION_ID.
export function sessionIdFromEnv(env = process.env) {
  const raw = env.COWART_SESSION_ID || env.CLAUDE_CODE_HOST_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || (env.CODEX_THREAD_ID ? `codex-${env.CODEX_THREAD_ID}` : '')
  return String(raw).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 96) || null
}

// Codex gives its prompt hook the thread on stdin (session_id) and not in the environment (S3 ⓪
// of docs/plan/codex-cli-resident.md): the session is the command's (D7), else codex-<that>.
export function hookSessionId(env = process.env, input = null) {
  const thread = typeof input?.session_id === 'string' ? input.session_id : ''
  return sessionIdFromEnv(env.CODEX_THREAD_ID || !thread ? env : { ...env, CODEX_THREAD_ID: thread })
}

// Which host runs the command: COWART_HOST when set (tests), else Claude Code when it gave the
// command its variables, else Codex when it gave its thread, else Claude Code. The texts differ
// by host (Codex has no Browser pane, no AskUserQuestion, no background listener). Claude Code's
// are the ones it gives the commands of a session; other CLAUDE_CODE_* are set for the whole
// machine (CLAUDE_CODE_GIT_BASH_PATH on Windows) and reach Codex's commands too.
const CLAUDE_CODE_SESSION_VARIABLES = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']
export function hostFromEnv(env = process.env) {
  const given = String(env.COWART_HOST ?? '').trim().toLowerCase()
  if (given) return given
  if (CLAUDE_CODE_SESSION_VARIABLES.some((key) => env[key])) return 'claude'
  return env.CODEX_THREAD_ID ? 'codex' : 'claude'
}

// How texts tell the session to run cowart: through the file `install` wrote when it leads here
// (named the way the host's shell reads it: commandLinkShown).
export function cowartCommand(host = 'claude') {
  return samePath(linkTarget(), ENTRY) ? `node ${commandLinkShown(host)}` : `node "${ENTRY.replaceAll('\\', '/')}"`
}

class UsageError extends Error {}

const kebab = (name) => name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
const camel = (name) => name.replace(/-([a-z])/g, (_, char) => char.toUpperCase())

// ---- Flags ----------------------------------------------------------------------------

// A command's own flags: kind says how the value reads (pair: "x,y"; size: "w,h" or "w"; page:
// a page name or id; switch: no value), set puts it into the tool's parameters (into: 'item'
// for one entry of a list tool's items / updates), covers names the tool parameters it stands
// for (left out of help's 少用的参数). A command's hidden tool parameters are ones it has no use
// for or another command does (open's shownPage is take --shown): still read, never offered.
// needs: the command is about its first positional (or what needs(args) says) and stops at its
// usage without it. ownAnchor: an insert whose anchor is only what --next-to / --replace name,
// never the user's selection (upstream takes a lone selected shape for one).
const SIDES = ['right', 'left', 'below', 'above']
const pageFlag = (about) => ({ kind: 'page', arg: '<页名或 id>', about, covers: ['pageId'], set: (target, value) => (target.pageId = value) })
const atFlag = (about, into) => ({ kind: 'pair', arg: '<x,y>', about, into, covers: ['x', 'y'], set: (target, [x, y]) => Object.assign(target, { x, y }) })
const nextToFlag = (about, into) => ({ kind: 'text', arg: '<shape id>', about, into, covers: ['anchorShapeId'], set: (target, value) => (target.anchorShapeId = value) })
const sideFlag = (about, into) => ({ kind: 'text', arg: SIDES.join('|'), choices: SIDES, about, into, covers: ['placement'], set: (target, value) => (target.placement = value) })
const displaySizeFlag = {
  kind: 'size',
  arg: '<宽,高>',
  about: '显示尺寸；只给宽就按原比例',
  covers: ['displayWidth', 'displayHeight'],
  set: (target, [w, h]) => {
    target.displayWidth = w
    if (h !== undefined) target.displayHeight = h
    target.matchAnchor ??= false
  }
}
// open / take: the page into a folder of the page menu (page-folders.mjs).
const FOLDER_FLAG = {
  kind: 'text',
  arg: '<文件夹>',
  about: '这一页放进页菜单的这个文件夹（一层层用 / 隔开：数码宝贝/参考；/ 是顶层），新建的页、已有的页都行；用户说了文件夹才给',
  covers: ['folder'],
  set: (target, value) => (target.folder = value)
}
// Where put image / video / html go.
const PLACE = {
  at: atFlag('放在页面上这个位置（左上角）'),
  'next-to': nextToFlag('放在这个图形旁边（默认右边、跟它一样大；旁边是分组框时保持自己的大小）'),
  side: sideFlag('放在 --next-to 的哪一边（默认 right）'),
  size: displaySizeFlag,
  page: pageFlag('放进这一页（默认：你负责的页；没负责页时是面板正看着的页）')
}

const COMMANDS = [
  // 会话
  {
    name: 'open',
    group: '会话',
    tool: RENDER_TOOL,
    positional: ['page'],
    usage: 'open [页名] [--name <你的名字>] [--folder <文件夹>]',
    about: '打开画布：给网址、你的名字、负责哪页、下一步；带页名 = 进入 / 接管这一页（没有就建）',
    flags: { name: { kind: 'text', arg: '<名字>', about: '你在画布上的名字（第一次打开时起一个，之后不换）', covers: ['sessionName'], set: (target, value) => (target.sessionName = value) }, folder: FOLDER_FLAG },
    hidden: ['shownPage', 'title'],
    result: 'open'
  },
  {
    name: 'take',
    group: '会话',
    tool: RENDER_TOOL,
    positional: ['page'],
    usage: 'take <页名> [--folder <文件夹>] | take --shown',
    about: '换你负责的页：进入 / 接管这一页（没有就建），--shown 接管面板正看着的页；面板跟过去',
    flags: { shown: { kind: 'switch', about: '接管你的画布面板正看着的那一页（「接管这页」）', covers: ['shownPage'], set: (target, value) => (target.shownPage = value) }, folder: FOLDER_FLAG },
    hidden: ['sessionName', 'title'],
    result: 'take'
  },
  // 看
  // 页：the canvas's pages and the page menu's folders.
  { name: 'pages', group: '页', usage: 'pages [文件夹]', about: '画布上的页，按页菜单的文件夹排：页名、谁负责、几个图形；给了文件夹就只列它里面的', run: 'pages' },
  { name: 'page', group: '看', usage: 'page [页名]', about: '一页上有什么：图形、位置尺寸、素材本地路径、标注指向；默认看你负责的页', run: 'page' },
  { name: 'selection', group: '看', tool: 'get_cowart_selection', usage: 'selection', about: '用户在本会话画布面板里选中的东西：位置尺寸、所在的分组框、素材本地路径', result: 'selection' },
  // 放
  {
    name: 'put image',
    group: '放',
    tool: 'insert_cowart_image',
    positional: ['imagePath'],
    usage: 'put image <图片> [--at x,y | --next-to <id> [--side …] | --replace <AI 图片框或卡片>] [--size 宽,高] [--page <页>]',
    about: '放图片；--replace 换掉 AI 图片框或一张卡片（新图放进它的位置）',
    flags: {
      ...PLACE,
      replace: { kind: 'text', arg: '<AI 图片框或卡片 id>', about: '替换这个 AI 图片框，或者一张卡片（图、视频、HTML）：新图等比放进它的位置、居中，在同一个分组框里；卡片删掉，文件留在素材目录', covers: ['replaceShapeId', 'replaceAiImageHolder'], set: (target, value) => (target.replaceShapeId = value) }
    },
    hidden: ['cowartUrl', 'shapeMeta', 'assetMeta'],
    needs: true,
    ownAnchor: true
  },
  {
    name: 'put video',
    group: '放',
    tool: INSERT_VIDEO_TOOL,
    positional: ['videoPath'],
    usage: 'put video <视频> [--at x,y | --next-to <id> [--side …] | --replace <AI 视频框>] [--size 宽,高] [--page <页>]',
    about: '放视频；--replace 替换 AI 视频框',
    flags: {
      ...PLACE,
      replace: { kind: 'text', arg: '<AI 视频框 id>', about: '替换这个 AI 视频框：视频放进框里', covers: ['replaceHolderShapeId'], set: (target, value) => (target.replaceHolderShapeId = value) }
    },
    hidden: ['shapeMeta'],
    needs: true
  },
  {
    name: 'put html',
    group: '放',
    tool: 'insert_cowart_html_draft',
    positional: ['htmlPath'],
    usage: 'put html <HTML 文件> [--at x,y | --next-to <id> [--side …] | --replace <AI HTML 框> | --slide-of <Slides 框>] [--size 宽,高] [--page <页>]',
    about: '放 HTML 草稿；--replace 替换 AI HTML 框，--slide-of 给 AI Slides 加一页',
    flags: {
      ...PLACE,
      // Upstream takes the anchor for the draft to fill: beside an HTML draft it would rewrite that one.
      'next-to': { ...PLACE['next-to'], covers: ['anchorShapeId', 'updateExistingDraft'], set: (target, value) => Object.assign(target, { anchorShapeId: value, updateExistingDraft: false }) },
      replace: { kind: 'text', arg: '<AI HTML 框 id>', about: '替换这个 AI HTML 框（给的是一份 HTML 草稿就换掉它的内容）', covers: ['draftShapeId', 'replaceDraftHolder'], set: (target, value) => (target.draftShapeId = value) },
      'slide-of': {
        kind: 'text',
        arg: '<Slides 框 id>',
        about: '给这个 AI Slides 加一页（不替换、不删 Slides 框）',
        covers: ['updateExistingDraft'],
        set: (target, value) => Object.assign(target, { draftShapeId: value, replaceDraftHolder: false, updateExistingDraft: false, matchAnchor: false })
      }
    },
    // The HTML comes in a file (htmlContent is for call, the way a request spells it).
    hidden: ['htmlContent', 'shapeMeta'],
    needs: (args) => Boolean(args.htmlPath || args.htmlContent),
    ownAnchor: true
  },
  {
    name: 'put text',
    group: '放',
    tool: 'insert_cowart_text',
    positional: ['text'],
    item: 'items',
    batchExample: '{"text": "1", "next-to": "shape:…", "align": "middle"}',
    usage: 'put text <文字> [--at x,y | --next-to <id> [--side below]] [--font-size s|m|l|xl] [--align middle] [--into <框>] [--page <页>]',
    about: "放文字：编号、标题、说明；放在 --next-to 的下面时跟它一样宽；一次多条用 --json '[{\"text\":…}, …]'",
    flags: {
      at: atFlag('放在页面上这个位置（左上角）', 'item'),
      'next-to': nextToFlag('挂在这个图形旁边（默认下面）', 'item'),
      side: sideFlag('挂在 --next-to 的哪一边（默认 below）', 'item'),
      'font-size': { kind: 'text', arg: 's|m|l|xl', choices: ['s', 'm', 'l', 'xl'], into: 'item', about: '字号（默认 m）', covers: ['size'], set: (target, value) => (target.size = value) },
      align: { kind: 'text', arg: 'start|middle|end', choices: ['start', 'middle', 'end'], into: 'item', about: '文字框里的对齐', covers: ['textAlign'], set: (target, value) => (target.textAlign = value) },
      into: { kind: 'text', arg: '<框 id>|page', into: 'item', about: '放进这个分组框（框跟着长大）', covers: ['frameId'], set: (target, value) => (target.frameId = value) },
      page: pageFlag('放进这一页（默认：你负责的页）')
    },
    needs: true
  },
  // 整理
  {
    name: 'group',
    group: '整理',
    tool: 'insert_cowart_frame',
    positional: ['name', '...shapeIds'],
    usage: 'group <标题> <shape id>… [--padding 40]',
    about: '建分组框，把这些图形原地框进去（不给图形就用 --at 和 --size 建一个空框）',
    flags: {
      padding: { kind: 'number', arg: '<像素>', about: '图形到框边的距离（默认 40）', covers: ['padding'], set: (target, value) => (target.padding = value) },
      at: { kind: 'pair', arg: '<x,y>', about: '空框的位置（左上角）', covers: ['x', 'y'], set: (target, [x, y]) => Object.assign(target, { x, y }) },
      size: { kind: 'size', arg: '<宽,高>', about: '空框的尺寸', covers: ['w', 'h'], set: (target, [w, h]) => Object.assign(target, { w, ...(h !== undefined ? { h } : {}) }) },
      page: pageFlag('建在这一页（默认：你负责的页）')
    },
    needs: true
  },
  {
    name: 'edit',
    group: '整理',
    tool: 'update_cowart_shapes',
    positional: ['shapeId'],
    item: 'updates',
    batchExample: '{"shapeId": "shape:…", "by": "40,0"}',
    usage: 'edit <shape id> [--at x,y | --by dx,dy] [--size 宽,高] [--text …] [--title …] [--into <框>|page] [--fit [--padding 40]]',
    about: "移动、改尺寸、改文字 / 框标题、进出分组框；一批一起改用 --json '[{\"shapeId\":…}, …]'",
    flags: {
      at: atFlag('移到页面上这个位置（左上角）', 'item'),
      by: { kind: 'pair', arg: '<dx,dy>', into: 'item', about: '相对移动', covers: ['dx', 'dy'], set: (target, [dx, dy]) => Object.assign(target, { dx, dy }) },
      size: { kind: 'size', arg: '<宽,高>', into: 'item', about: '新尺寸；图片 / 视频只给宽就按比例', covers: ['w', 'h'], set: (target, [w, h]) => Object.assign(target, { w, ...(h !== undefined ? { h } : {}) }) },
      text: { kind: 'text', arg: '<文字>', into: 'item', about: '文字框的新文字', covers: ['text'], set: (target, value) => (target.text = value) },
      title: { kind: 'text', arg: '<标题>', into: 'item', about: '分组框的新标题', covers: ['name'], set: (target, value) => (target.name = value) },
      into: { kind: 'text', arg: '<框 id>|page', into: 'item', about: '放进这个分组框；page 拿出来（位置不变）', covers: ['frameId'], set: (target, value) => (target.frameId = value) },
      fit: { kind: 'switch', into: 'item', about: '分组框贴合里面的东西（放进、挪动之后框太大或太小时）', covers: ['fit'], set: (target, value) => (target.fit = value) },
      padding: { kind: 'number', arg: '<像素>', into: 'item', about: '--fit 时内容到框边的距离（默认 40）', covers: ['padding'], set: (target, value) => (target.padding = value) },
      page: pageFlag('改的是这一页（一般不用给）')
    },
    needs: true
  },
  {
    name: 'folder',
    group: '页',
    tool: MOVE_PAGES_TOOL,
    positional: ['folder', '...pages'],
    usage: 'folder <文件夹> <页名>… | folder <新文件夹> --from <旧文件夹>',
    about: '把页放进页菜单的文件夹（一层层用 / 隔开：数码宝贝/参考；/ 是顶层），--from 把整个文件夹挪过去、改名；用户要你归类时才用',
    flags: {
      from: { kind: 'text', arg: '<文件夹>', about: '挪这个文件夹（连同里面的页和子文件夹）到 <新文件夹>：改名、换位置；<新文件夹> 是 / 就拆掉它', covers: ['fromFolder'], set: (target, value) => (target.fromFolder = value) }
    },
    needs: true
  },
  {
    name: 'delete',
    group: '整理',
    tool: 'delete_cowart_shapes',
    positional: ['...shapeIds'],
    usage: 'delete <shape id>… [--with-contents]',
    about: '删除图形（页面上 Ctrl+Z 撤不回；删分组框默认留下里面的东西）',
    flags: {
      'with-contents': { kind: 'switch', about: '删分组框时连里面的东西一起删', covers: ['deleteChildren'], set: (target, value) => (target.deleteChildren = value) },
      page: pageFlag('删的是这一页上的（一般不用给）')
    },
    needs: true
  },
  // 请求
  { name: 'requests', group: '请求', tool: LIST_REQUESTS_TOOL, usage: 'requests [--all]', about: '本会话的画布请求（「看画布」：取排队的请求）', flags: { all: { kind: 'switch', about: '连做完的也列出来', covers: ['includeFinished'], set: (target, value) => (target.includeFinished = value) } } },
  { name: 'request', group: '请求', tool: GET_REQUEST_TOOL, positional: ['id'], needs: true, usage: 'request <编号>', about: '画布请求的详情（原始请求 + 宿主说明）' },
  { name: 'reply', group: '请求', tool: REPLY_REQUEST_TOOL, positional: ['id', 'status', '...message'], needs: true, usage: `reply <编号> ${AGENT_STATUSES.join('|')} [一句话]`, about: '回画布请求的状态，画布顶部照着显示' },
  // 其它
  {
    name: 'feedback',
    group: '其它',
    tool: 'send_cowart_feedback',
    positional: ['...text'],
    usage: 'feedback <用户原话> --title <一句话> --kind bug|friction|idea [--details …] [--shapes <id>,…] [--files <路径>,…]',
    about: '记下用户对 Cowart 本身的意见',
    flags: {
      title: { kind: 'text', arg: '<一句话>', about: '标题，用户的语言，二十个字左右', covers: ['title'], set: (target, value) => (target.title = value) },
      kind: { kind: 'text', arg: 'bug|friction|idea', choices: ['bug', 'friction', 'idea'], about: 'bug：坏了、结果不对；friction：能用但别扭、慢、难找；idea：想要的新功能', covers: ['kind'], set: (target, value) => (target.kind = value) },
      details: { kind: 'text', arg: '<情况>', about: '你知道的情况：用户在做什么、发生了什么、期望什么（用户原话放在前面的 <用户原话>）', covers: ['details'], set: (target, value) => (target.details = value) },
      shapes: { kind: 'list', arg: '<shape id>,…', about: '说的是画布上的这些图形', covers: ['shapeIds'], set: (target, value) => (target.shapeIds = value) },
      files: { kind: 'list', arg: '<路径>,…', about: '一起留下的本地文件（截图、生成结果、日志）', covers: ['attachments'], set: (target, value) => (target.attachments = value) },
      page: pageFlag('说的是这一页（不是你负责或正看着的页时才给）')
    },
    needs: true
  }
]

// The commands that are not one tool: [group, names, usage, about].
const OTHER_COMMANDS = [
  ['会话', ['listen'], 'listen', '画布请求监听：用 Bash 工具后台跑（run_in_background: true，description 写「Cowart 画布请求」），来了请求才退出，退出的通知叫醒你；它连着就表示这个会话在线。别用 Monitor 跑（最多 30 分钟，到点就叫醒会话）'],
  ['其它', ['call'], "call <工具名> [--json '{…}']", '照工具定义直接调一个工具（画布请求里按 Codex 写的工具调用照搬到这里）；参数也能写成 --kebab-case'],
  ['其它', ['tools'], 'tools [<工具名>]', '列出所有工具；给了工具名就打出它的参数定义'],
  ['其它', ['hook'], 'hook prompt', 'Codex 的提醒 hook（install 装进 Codex 的 hooks.json，用户每发一句话 Codex 跑一次）：画布上有请求在等这个会话就提醒一句，没有就什么都不打；会话里不用自己跑'],
  ['其它', ['help'], 'help [<命令>]', '用法；给了命令就列出它的全部参数'],
  ['其它', ['install', 'uninstall'], 'install / uninstall', installAbout('claude')]
]
function installAbout(host) {
  return `把 ${commandLinkShown(host)} 指向这一份 Cowart，并装上画布服务的开机自启（Windows）；这台机器装了 Codex 的话，再给它装上 cowart skill 和提醒 hook、去掉原来的 cowart_mcp / 删掉这些`
}
// Codex runs no listener: its requests wait until the user asks for them (看画布).
const CODEX_LISTEN_ABOUT = 'Codex 不用：画布请求不会叫醒 Codex 会话，用户说「看画布」（或答应要做）时用 requests 取，request <编号> 看详情照做'

function otherCommands(host) {
  if (host !== 'codex') return OTHER_COMMANDS
  return OTHER_COMMANDS.map(([group, names, name, about]) => [group, names, name, names.includes('listen') ? CODEX_LISTEN_ABOUT : names.includes('install') ? installAbout(host) : about])
}

// What the tool parameters a command has no flag of its own for do, for help (the tools'
// definitions are upstream's, in English or without a word).
const PARAM_ABOUT = {
  sourceShapeId: '按标注修改的原图：新图当它的修改版放在旁边（跟 --next-to 一样当锚点）',
  annotationScreenshot: '按标注修改时那张标注截图的本地路径（记在新图上）',
  fileName: '存进页素材目录时的文件名（默认用原文件名）',
  margin: '跟 --next-to 的图形之间的空隙',
  matchAnchor: '跟 --next-to 的图形一样大（默认是；旁边是分组框、给了 --size 时不跟）；--no-match-anchor 保持自己的大小',
  altText: '替代文字',
  dryRun: '只算出放在哪、多大，不真放',
  videoWidth: '视频的像素宽（文件里读不出来时才给）',
  videoHeight: '视频的像素高（文件里读不出来时才给）',
  width: '文字框的宽（默认按字数；挂在卡片上下时跟卡片一样宽）',
  color: '颜色',
  font: '字体'
}

function otherCommandNamed(name, host = 'claude') {
  return otherCommands(host).find(([, names]) => names.includes(name)) ?? null
}

const GLOBAL_FLAGS = [
  ['--json <JSON>', "参数对象（- 从标准输入读）；put text、edit 也能给一个数组，一次多条"],
  ['--json-file <文件>', '从文件读 --json'],
  ['--out json', '打出完整的结果 JSON，而不是给人读的文字']
]

function commandNamed(name) {
  return COMMANDS.find((command) => command.name === name || command.tool === name) ?? null
}

// ---- Arguments ------------------------------------------------------------------------

function parseJson(text, what) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UsageError(`${what} 不是合法的 JSON：${error.message}`)
  }
}

function numberOf(raw, flag, { integer = false } = {}) {
  const number = Number(raw)
  if (String(raw).trim() === '' || !Number.isFinite(number) || (integer && !Number.isInteger(number))) {
    throw new UsageError(`--${flag} 要一个${integer ? '整数' : '数'}，「${raw}」不是。`)
  }
  return number
}

// A value of a tool parameter, by its schema.
function coerce(value, schema = {}, flag) {
  const type = schema.type
  if (value === true) {
    if (type === undefined || type === 'boolean') return true
    throw new UsageError(`--${flag} 后面要给一个值。`)
  }
  if (type === 'boolean') {
    if (/^(true|1|yes)$/i.test(value)) return true
    if (/^(false|0|no)$/i.test(value)) return false
    throw new UsageError(`--${flag} 只能是 true 或 false。`)
  }
  if (type === 'number' || type === 'integer') return numberOf(value, flag, { integer: type === 'integer' })
  if (type === 'array') {
    const items = value.trim().startsWith('[') ? parseJson(value, `--${flag}`) : value.split(',').map((item) => item.trim()).filter(Boolean)
    if (!Array.isArray(items)) throw new UsageError(`--${flag} 要一个列表。`)
    return items.map((item) => (typeof item === 'string' ? coerce(item, schema.items, flag) : item))
  }
  if (type === 'object') {
    const object = parseJson(value, `--${flag}`)
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new UsageError(`--${flag} 要一个 JSON 对象。`)
    return object
  }
  if (schema.enum && !schema.enum.includes(value)) throw new UsageError(`--${flag} 只能是 ${schema.enum.join(' / ')}，不能是「${value}」。`)
  return value
}

// A value of a command's own flag, by its kind.
function readOwnFlag(spec, value, flag) {
  if (spec.kind === 'switch') return coerce(value, { type: 'boolean' }, flag)
  if (value === true) throw new UsageError(`--${flag} 后面要给 ${spec.arg}。`)
  if (spec.kind === 'pair' || spec.kind === 'size') {
    const parts = String(value).split(',').map((part) => part.trim())
    if (parts.length > 2 || (spec.kind === 'pair' && parts.length !== 2)) throw new UsageError(`--${flag} 要写成 ${spec.arg}，「${value}」不是。`)
    return parts.map((part) => numberOf(part, flag))
  }
  if (spec.kind === 'number') return numberOf(value, flag)
  if (spec.kind === 'list') return String(value).split(',').map((item) => item.trim()).filter(Boolean)
  if (spec.choices && !spec.choices.includes(value)) throw new UsageError(`--${flag} 只能是 ${spec.choices.join(' / ')}，不能是「${value}」。`)
  return value
}

// Splits the arguments into the parameter object (--json / --json-file), flags and positionals.
// A flag's value is the next argument, except for a flag that takes none (takesValue says).
function tokenize(argv, takesValue) {
  const flags = []
  const positionals = []
  let json = null
  let jsonFile = null
  let out = 'text'
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (!token.startsWith('--') || token.length === 2) {
      positionals.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const name = token.slice(2, equals > 0 ? equals : undefined)
    const inline = equals > 0 ? token.slice(equals + 1) : undefined
    const next = () => {
      if (inline !== undefined) return inline
      if (index + 1 >= argv.length) throw new UsageError(`--${name} 后面要给值。`)
      index += 1
      return argv[index]
    }
    if (name === 'json') json = next()
    else if (name === 'json-file') jsonFile = next()
    else if (name === 'out') out = next()
    else if (name === 'help') flags.push({ name: 'help', value: true })
    else if (inline !== undefined) flags.push({ name, value: inline })
    else if (!takesValue(name)) {
      // A switch: --fit, --fit false, --no-fit.
      const following = argv[index + 1]
      if (following !== undefined && /^(true|false)$/i.test(following)) {
        index += 1
        flags.push({ name, value: following })
      } else {
        flags.push({ name, value: true })
      }
    } else {
      flags.push({ name, value: next() })
    }
  }
  return { flags, positionals, json, jsonFile, out }
}

// Where a flag goes: the command's own flag, or a tool parameter by its name
// ({ key, schema, into: 'top' | 'item' }); null when neither.
function flagSpec(command, schema, name) {
  const own = command?.flags?.[name]
  if (own) return { own, into: own.into ?? 'top' }
  const properties = schema?.properties ?? {}
  const itemProperties = command?.item ? properties[command.item]?.items?.properties ?? {} : {}
  const lookup = (flag) => {
    const key = flag in properties || flag in itemProperties ? flag : camel(flag)
    if (key in properties && key !== command?.item) return { key, schema: properties[key], into: 'top' }
    if (key in itemProperties) return { key, schema: itemProperties[key], into: 'item' }
    return null
  }
  const spec = lookup(name)
  if (spec) return spec
  // --no-fit
  if (name.startsWith('no-')) {
    const ownNegated = command?.flags?.[name.slice(3)]
    if (ownNegated?.kind === 'switch') return { own: ownNegated, into: ownNegated.into ?? 'top', negated: true }
    const negated = lookup(name.slice(3))
    if (negated?.schema?.type === 'boolean') return { ...negated, negated: true }
  }
  return null
}

function takesValue(spec) {
  if (!spec) return true
  if (spec.negated) return false
  return spec.own ? spec.own.kind !== 'switch' : spec.schema?.type !== 'boolean'
}

// The tool parameters a command's own flags do not stand for, as flags.
function otherFlags(command, schema) {
  const covered = new Set([...Object.values(command?.flags ?? {}).flatMap((flag) => flag.covers ?? []), ...(command?.hidden ?? [])])
  for (const slot of command?.positional ?? []) covered.add(slot.replace(/^\.\.\./, ''))
  const properties = schema?.properties ?? {}
  const itemProperties = command?.item ? properties[command.item]?.items?.properties ?? {} : {}
  const keys = [...Object.keys(properties).filter((key) => key !== command?.item), ...Object.keys(itemProperties)]
  return keys.filter((key) => !covered.has(key))
}

function knownFlags(command, schema) {
  return [...Object.keys(command?.flags ?? {}), ...otherFlags(command, schema).map(kebab)].map((flag) => `--${flag}`)
}

async function readParameters(json, jsonFile, command) {
  let args = {}
  const take = (value, what) => {
    // A list tool (put text, edit) takes the list itself.
    if (Array.isArray(value) && command?.item) return { [command.item]: value }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UsageError(`${what} 要一个 JSON 对象${command?.item ? '或数组' : ''}。`)
    return value
  }
  if (jsonFile) args = take(parseJson(await readFile(jsonFile, 'utf8'), `--json-file ${jsonFile}`), '--json-file')
  if (json !== null) {
    const text = json === '-' ? await readStdin() : json
    args = { ...args, ...take(parseJson(text, '--json'), '--json') }
  }
  return args
}

// An entry of a batch (put text / edit --json '[…]') written with the command's own flag names
// ("next-to", "align", "at": "x,y" or [x, y]), as one entry is on the command line; the tool's
// fields still work. 2026-10-22: a batch had to be written in anchorShapeId and textAlign.
function itemFromFlags(command, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
  const item = {}
  for (const [key, value] of Object.entries(entry)) {
    const name = command.flags?.[key] ? key : command.flags?.[kebab(key)] ? kebab(key) : null
    const spec = name ? command.flags[name] : null
    if (!spec || spec.into !== 'item') {
      item[key] = value
      continue
    }
    const read = spec.kind === 'switch'
      ? value !== false && value !== 'false'
      : Array.isArray(value) ? value.map((part) => numberOf(part, name)) : readOwnFlag(spec, String(value), name)
    spec.set(item, read)
  }
  return item
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// The tool's parameters from the command line. Page names (--page) come back unresolved in
// args.pageId; the caller resolves them.
export async function buildArguments(command, schema, argv) {
  const parsed = tokenize(argv, (name) => takesValue(flagSpec(command, schema, name)))
  const args = await readParameters(parsed.json, parsed.jsonFile, command)
  if (command?.item && Array.isArray(args[command.item])) args[command.item] = args[command.item].map((entry) => itemFromFlags(command, entry))
  const item = {}
  const given = new Set()
  for (const { name, value } of parsed.flags) {
    if (name === 'help') continue
    const spec = flagSpec(command, schema, name)
    if (!spec) {
      const known = knownFlags(command, schema)
      throw new UsageError(`不认识 --${name}。${known.length ? `能用的参数：${known.join(' ')}` : '这个命令没有参数。'}`)
    }
    const target = spec.into === 'item' ? item : args
    if (spec.own) {
      const read = readOwnFlag(spec.own, value, name)
      spec.own.set(target, spec.negated ? !read : read)
      continue
    }
    const coerced = spec.negated ? !coerce(value, spec.schema, name) : coerce(value, spec.schema, name)
    // A list flag given again adds to it.
    target[spec.key] = Array.isArray(coerced) && Array.isArray(target[spec.key]) && given.has(spec.key) ? [...target[spec.key], ...coerced] : coerced
    given.add(spec.key)
  }
  const values = [...parsed.positionals]
  for (const slot of command?.positional ?? []) {
    if (values.length === 0) break
    const rest = slot.startsWith('...')
    const key = rest ? slot.slice(3) : slot
    const spec = flagSpec(command, schema, key) ?? { key, schema: {}, into: 'top' }
    const taken = rest ? values.splice(0) : [values.shift()]
    const value = spec.schema?.type === 'array' ? taken.flatMap((entry) => coerce(entry, spec.schema, key)) : coerce(taken.join(' '), spec.schema, key)
    ;(spec.into === 'item' ? item : args)[spec.key ?? key] = value
  }
  if (values.length > 0) throw new UsageError(`多出来的参数：${values.join(' ')}（用法：${command ? command.usage : 'call <工具名> …'}）`)
  if (Object.keys(item).length > 0) args[command.item] = [...(Array.isArray(args[command.item]) ? args[command.item] : []), item]
  return { args, out: parsed.out, help: parsed.flags.some((flag) => flag.name === 'help') }
}

// ---- Results --------------------------------------------------------------------------

function textResult(text, structuredContent) {
  return structuredContent === undefined
    ? { content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }], structuredContent }
}

function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

// Upstream's tools answer in English; a command answers in the words of the rest of its
// output. The first line of an insert names the shape, where it went and its file.
const round = (value) => Math.round(Number(value) * 100) / 100
const placed = (s) => `${round(s.bounds.w)}×${round(s.bounds.h)}，位于 ${s.pageId} 的 (${round(s.bounds.x)}, ${round(s.bounds.y)})`
const fileName = (path) => String(path ?? '').split(/[\\/]/).pop()
// The file it came from, when upstream renamed it (it keeps only ASCII): 猫-水彩.png, not image.png.
const stem = (name) => name.replace(/\.[^.]+$/, '')
const cameFrom = (s) => {
  const source = fileName(s.sourceImagePath)
  return source && !stem(fileName(s.assetFile)).startsWith(stem(source)) ? `（${source}）` : ''
}
const RESTATED = {
  insert_cowart_image: (s) =>
    `${s.dryRun ? '算好了（没放）：图片' : '已插入图片'} ${s.shapeId}${cameFrom(s)}：${placed(s)}${s.replacedAiImageHolder ? `，替换了 AI 图片框 ${s.anchorShapeId}` : ''}；文件 ${s.assetFile}`,
  insert_cowart_html_draft: (s) =>
    `${s.dryRun ? '算好了（没放）：HTML 草稿' : '已插入 HTML 草稿'} ${s.shapeId}：${placed(s)}${s.replacedAiDraftHolder ? `，替换了 AI HTML 框 ${s.draftShapeId}` : ''}${s.updatedExistingHtmlDraft ? '，更新了原来那份草稿' : ''}；文件 ${s.assetFile}`
}

const UPSTREAM_ERRORS = [
  [/^Missing (?:anchor shape|shape): (\S+)$/, (id) => `画布上没有图形 ${id}（page 命令列出这一页的图形）。`],
  [/^Missing AI draft holder shape: (\S+)$/, (id) => `画布上没有 AI HTML 框 ${id}（page 命令列出这一页的图形）。`],
  [/^Missing AI image holder shape: (\S+)$/, (id) => `画布上没有 AI 图片框 ${id}（page 命令列出这一页的图形）。`],
  [/^ENOENT: no such file or directory, \w+ '(.+)'$/, (path) => `找不到文件：${path}`],
  [/^(?:imagePath|htmlPath) is not a file: (.+)$/, (path) => `不是文件：${path}`],
  [/^Could not read image dimensions for (.+?)\. /, (path) => `读不出 ${path} 的尺寸：换成 PNG / JPEG / WebP，或给 --size 宽,高。`],
  [/^HTML draft content is empty\.$/, () => 'HTML 文件是空的。'],
  [/^imagePath is required\.$/, () => '要给图片的本地路径。'],
  [/^htmlContent or htmlPath is required\.$/, () => '要给 HTML 文件的路径。']
]

export function localizeError(message) {
  for (const [pattern, say] of UPSTREAM_ERRORS) {
    const match = pattern.exec(message)
    if (match) return say(...match.slice(1))
  }
  return message
}

// The layout tools (canvas-edit.mjs) speak in their parameters, for the models that call them:
// which entry of a batch a message is about (updates[0].shapeId：) and what to call next. A
// command speaks in its flags and commands (call keeps the tools' words).
const COMMAND_WORDS = [
  [/（id 以 get_cowart_canvas_state 列出的为准）/g, '（page 命令列出这一页的图形）'],
  [/（建好后可以用 update_cowart_shapes 调）/g, '（建好后可以用 edit 调）'],
  [/update_cowart_shapes 给图形传 frameId 放进来/g, 'edit <图形 id> --into <框 id> 放进来'],
  [
    /超出了分组框 (shape:[^\s「，]+)(「[^」]*」)?，页面上超出的部分会被裁掉：给这个框 fit: true，或者给 (\S+) frameId: "page" 拿出来/g,
    '超出了分组框 $1$2，页面上超出的部分会被裁掉：edit $1 --fit 让框包住它，或者 edit $3 --into page 拿出来'
  ],
  [/要放回就用 insert_cowart_image \/ insert_cowart_video/g, '要放回就用 put image / put video'],
  [/x \/ y 和 anchorShapeId 只给一种/g, '--at 和 --next-to 只给一种'],
  [/x \/ y 和 dx \/ dy 只给一种/g, '--at 和 --by 只给一种'],
  [/给 x 和 y（文字框左上角的页面坐标），或者给 anchorShapeId/g, '给 --at x,y（文字框左上角的页面坐标），或者给 --next-to <id>'],
  [/frameId 是空的（拿出分组框用 "page"）/g, '--into 是空的（拿出分组框用 --into page）'],
  [/（update_cowart_shapes 给 dx \/ dy，框会带着里面的东西走）/g, '（edit <框 id> --by dx,dy，框会带着里面的东西走）'],
  [/（update_cowart_shapes：它们 frameId: "(shape:[^"]+)"，框 fit: true）/g, '（edit <它的 id> --into $1，再 edit $1 --fit）'],
  [/(^|\n)replaceShapeId：/g, '$1']
]

// entries: how many items / updates the command sent; one needs no number.
export function inCommandWords(text, entries = 1) {
  let said = text
  for (const [pattern, words] of COMMAND_WORDS) said = said.replace(pattern, words)
  said = said.replace(/(^|\n)(?:updates|items)\[(\d+)\](?:\.\w+)?：/g, (_, start, n) => `${start}${entries > 1 ? `第 ${Number(n) + 1} 条：` : ''}`)
  return said.replace(/(^|\n)shapeIds：/g, '$1')
}

// speaking: { entries } for a command, null for call.
export function restate(name, result, speaking = null) {
  const said = restated(name, result)
  if (!speaking) return said
  const text = resultText(said)
  const words = inCommandWords(text, speaking.entries)
  return words === text ? said : { ...said, content: [{ type: 'text', text: words }] }
}

function restated(name, result) {
  const structured = result?.structuredContent
  if (result?.isError) {
    const text = resultText(result)
    const said = localizeError(text)
    return said === text ? result : { ...result, content: [{ type: 'text', text: said }] }
  }
  if (name === 'get_cowart_selection' && structured?.selection) {
    const shapes = structured.selection.selectedShapes ?? []
    const head = shapes.length ? `你的画布面板里选中了 ${shapes.length} 个图形：` : '你的画布面板里什么都没选中。'
    return { ...result, content: [{ type: 'text', text: shapes.length ? `${head}\n${resultText(result)}` : head }] }
  }
  if (!RESTATED[name] || !structured?.shapeId || !structured.bounds) return result
  const [first = '', ...rest] = resultText(result).split('\n')
  if (!/^(Inserted|Planned) /.test(first)) return result
  return { ...result, content: [{ type: 'text', text: [RESTATED[name](structured), ...rest].join('\n') }] }
}

// A command run without what it is about (put text with no text, delete with no id): its
// usage, before the tool would answer in its parameters.
function missingSubject(command, args) {
  if (!command?.needs) return false
  if (typeof command.needs === 'function') return !command.needs(args)
  const key = command.positional?.[0]?.replace(/^\.\.\./, '')
  const holder = command.item ? (Array.isArray(args[command.item]) ? args[command.item][0] : null) ?? {} : args
  const value = key ? holder[key] : undefined
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
}

export function resultText(result) {
  return (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
}

const BACKGROUND_NOTICE = '这条请求来自画布的后台通知，不是用户在对话里说的话：还没问过用户的话，先用 AskUserQuestion 确认再执行；用户明确选了要做才执行，答「无偏好」、没选都不算。'

function confirmNote(request) {
  if (request.kind === 'video') {
    return `${BACKGROUND_NOTICE}模型和参数用户已经在画布面板里选好了（见请求），选项给「执行」「跳过」即可；问题里写明模型、是否花钱（云端消耗团队额度）、条数和大概耗时。`
  }
  if (request.kind === 'image') {
    return /^Model: 自动/m.test(request.text)
      ? `${BACKGROUND_NOTICE}用户选的是「自动」：先按请求里的选型说明挑好模板，问题里写明选了哪个、为什么、是否花钱、几张；选项给「执行（用所选模板）」「改用另一个合适的模板」「跳过」。`
      : `${BACKGROUND_NOTICE}模型和参数用户已经在画布面板里选好了（见请求），选项给「执行」「跳过」即可；问题里写明模型、是否花钱（云端消耗团队额度）和张数。`
  }
  if (request.kind === 'web') {
    return `${BACKGROUND_NOTICE}问题里写明要参考哪个网址做一版 HTML、用户画的标注（有的话逐条简述）和额外要求（都没有就说照样式做），这件事不花钱；选项给「执行」「跳过」。`
  }
  const task = requestTask(request)
  if (task === 'annotation-edit') return `${BACKGROUND_NOTICE}${ANNOTATION_EDIT_QUESTION}。`
  if (task === 'html') return `${BACKGROUND_NOTICE}问题里概括要做什么（画了标注的话简述标注），这件事不生图、不花钱；选项给「执行」「跳过」。`
  if (task === 'canvas') {
    return `${BACKGROUND_NOTICE}问题里概括要做什么；要生图的话选项给「执行（免费本地模型）」「执行（云端模型，消耗团队额度）」「跳过」，不生图就给「执行」「跳过」。`
  }
  return `${BACKGROUND_NOTICE}问题里概括要生成什么、几张 / 几段；选项给「执行（免费本地模型）」「执行（云端模型，消耗团队额度）」「跳过」。`
}

function generationNote(request, cli) {
  const imagegen = `画布的提示词是按 Codex 写的：凡是要求用 Codex 内置 imagegen / 当前可用的图片生成能力的地方，改用 beast-gen skill（先用 Skill 工具加载它，按它的规则出图）。免费本地档：文生图用 krea2，按标注 / 参考图改图用 flux2-klein；云端档用 lib-image（Lib Image 2.5，quality=low 起步）。模板与参数以 beast gen templates 现查为准。结果下载到本地后，按请求里的要求放上画布（${cli} put image <本地路径> …，或照搬请求写的 insert_cowart_image 调用）。`
  if (request.kind === 'video') {
    return `这是视频请求：先用 Skill 工具加载 beast-gen，按请求里写好的模板和参数提交，素材按请求的顺序上传后填进对应参数；生成后下载到本地，按请求放进画布：${cli} put video <本地路径> --replace <AI 视频框的 id>。`
  }
  if (request.kind === 'image') {
    return `这是图片请求：先用 Skill 工具加载 beast-gen，按请求里的模板和参数出图，按 skill 的要求先读对应参考（lib-image 2.5 系读 references/image-prompting.md，ideogram4 读 references/ideogram4-caption.md，透明底读 references/transparent-asset.md）；生成后下载到本地，Read 看图，再按请求放进画布：${cli} put image <本地路径> --replace <AI 图片框的 id>。`
  }
  if (request.kind === 'web') {
    return `这是网页复刻请求：先 Read 请求里的整页截图（很长时分段看），有标注的话逐张 Read 标注的局部截图，再读渲染后的页面代码；要看真实的颜色、字体、间距，或按坐标找标注指的元素，可以用 Browser 面板打开原网址（mcp__Claude_Browser__navigate，再用 read_page / javascript_tool 读计算后的样式、用 document.elementFromPoint 定位）。做成单文件 HTML 后按请求放进画布：${cli} put html <HTML 文件> --replace <AI HTML 框 id>。`
  }
  const task = requestTask(request)
  if (task === 'annotation-edit') return `${ANNOTATION_REMARKS_NOTE}用户选「按标注出新图」时：${imagegen}`
  if (task === 'html') {
    return `AI HTML / AI Slides 请求：不生图、不用 beast-gen；照请求写完整的单文件 HTML（CSS / JS 内联），按请求放进画布（${cli} put html <HTML 文件> …，或照搬请求写的 insert_cowart_html_draft 调用）。`
  }
  return imagegen
}

// Codex: no dialog, no listener. A request is read when the user said 看画布 or yes; one the
// user has not agreed to yet is mentioned at the end of the answer to what the user said.
const CODEX_ASK = '这条请求是用户在画布上点的，不是在对话里说的话：用户说了「看画布」、或答应要做，才照做；还没答应的，先答完用户的话，在回复末尾提一句这条请求、问要不要做，用户答应了再做，说不做就回 skipped。'

function codexConfirmNote(request) {
  if (request.kind === 'video' || request.kind === 'image') {
    return `${CODEX_ASK}模型和参数用户已经在画布面板里选好了（见请求），照着做；云端模型消耗团队额度，用户还不知道要花钱的话先说一句。`
  }
  const task = requestTask(request)
  if (task === 'canvas' || task === 'generate-image') {
    return `${CODEX_ASK}要生图而请求没写明用哪个模型时，用 Codex 内置的图片生成或本地免费的 beast 模板；要用云端模型（消耗团队额度）先问用户。`
  }
  return CODEX_ASK
}

function codexGenerationNote(request, cli) {
  const imagegen = `画布的提示词本来就是按 Codex 写的：要求用 Codex 内置 imagegen / 当前可用的图片生成能力的，就用 Codex 内置的图片生成；指定了猛兽（beast）模板的，照 beast-gen skill 提交（模板与参数以 beast gen templates 现查为准）。结果存到本地后，按请求里的要求放上画布（${cli} put image <本地路径> …，或照搬请求写的 insert_cowart_image 调用）。`
  if (request.kind === 'video') {
    return `这是视频请求：照 beast-gen skill，按请求里写好的模板和参数提交，素材按请求的顺序上传后填进对应参数；生成后下载到本地，按请求放进画布：${cli} put video <本地路径> --replace <AI 视频框的 id>。`
  }
  if (request.kind === 'image') {
    return /^Model: Codex imagegen/m.test(request.text)
      ? `这是图片请求，用户选的是 Codex imagegen：用 Codex 内置的图片生成出图（参考图按请求的顺序当视觉参考）；存到本地、看一眼没问题，再按请求放进画布：${cli} put image <本地路径> --replace <AI 图片框的 id>。`
      : `这是图片请求：照 beast-gen skill，按请求里的模板和参数出图，按 skill 的要求先读对应参考（lib-image 2.5 系读 references/image-prompting.md，ideogram4 读 references/ideogram4-caption.md，透明底读 references/transparent-asset.md）；生成后下载到本地、看一眼没问题，再按请求放进画布：${cli} put image <本地路径> --replace <AI 图片框的 id>。`
  }
  if (request.kind === 'web') {
    return `这是网页复刻请求：先看请求里的整页截图（很长时分段看），有标注的话逐张看标注的局部截图，再读渲染后的页面代码；要看真实的颜色、字体、间距，或按坐标找标注指的元素，可以在 Codex 的内置浏览器里打开原网址看。做成单文件 HTML 后按请求放进画布：${cli} put html <HTML 文件> --replace <AI HTML 框 id>。`
  }
  const task = requestTask(request)
  if (task === 'annotation-edit') return `${ANNOTATION_EDIT_NOTE}要出新图时：${imagegen}`
  if (task === 'html') {
    return `AI HTML / AI Slides 请求：不生图；照请求写完整的单文件 HTML（CSS / JS 内联），按请求放进画布（${cli} put html <HTML 文件> …，或照搬请求写的 insert_cowart_html_draft 调用）。`
  }
  return imagegen
}

function codexHostNotes(request, cli) {
  return [
    codexConfirmNote(request),
    '还没读过 cowart skill 的话，先读它：各类请求的做法、结果放哪一页、标注怎么读都在那里。',
    codexGenerationNote(request, cli),
    `请求里的工具调用（insert_cowart_… 和它们的参数）用 cowart 命令照搬最稳：${cli} call <工具名> --json '{…}'，参数原样放进去（路径写成 / 分隔）；也可以换成 ${cli} put 加统一的位置参数（${cli} help 看对应关系）。长 HTML 先写成文件，再传文件路径。`,
    '请求里给出的截图、参考图等本地路径可以直接打开看。',
    `请求开头的 [@Cowart](plugin://…) 是以前 Codex 插件的提及，忽略即可；请求说不要调用 render_cowart_canvas_widget 时，就是不要重新 ${cli} open。`,
    ...(request.pageId
      ? [`结果放进发出请求的那一页：put 带上 --page ${request.pageId}（call 就在参数里带 "pageId": "${request.pageId}"；请求里指定了卡片的就按卡片放；这一页后来换了别的会话负责也照样放得进去）。`]
      : []),
    `开始执行时运行 ${cli} reply ${request.id} running；完成后 ${cli} reply ${request.id} done "<一句结果>"；失败 ${cli} reply ${request.id} failed "<原因>"；用户说不做时 ${cli} reply ${request.id} skipped。画布上会显示这些状态；不回的话画布上一直等着、还能点撤销。`
  ]
}

export function hostNotes(request, cli = cowartCommand(), host = 'claude') {
  if (request.status === 'cancelled') {
    return ['用户已经在画布上撤销了这条请求：不要执行，也不用再问用户；正在问的话直接结束。']
  }
  if (host === 'codex') return codexHostNotes(request, cli)
  return [
    confirmNote(request),
    '还没加载过 cowart skill 的话，先用 Skill 工具加载它：各类请求的做法、结果放哪一页、标注怎么读都在那里。',
    generationNote(request, cli),
    `请求里的工具调用是按 Codex 写的（insert_cowart_… 和它们的参数）：照搬最稳——${cli} call <工具名> --json '{…}'，参数原样放进去（路径写成 / 分隔）；也可以换成 ${cli} put 加统一的位置参数（${cli} help 看对应关系）。长 HTML 先写成文件，再传文件路径。`,
    '请求里给出的截图、参考图等本地路径可以直接用 Read 工具查看。',
    `请求开头的 [@Cowart](plugin://…) 是 Codex 的插件提及，忽略即可；请求说不要调用 render_cowart_canvas_widget 时，就是不要重新 ${cli} open。`,
    ...(request.pageId
      ? [`结果放进发出请求的那一页：put 带上 --page ${request.pageId}（call 就在参数里带 "pageId": "${request.pageId}"；请求里指定了卡片的就按卡片放；这一页后来换了别的会话负责也照样放得进去）。`]
      : []),
    `开始执行时运行 ${cli} reply ${request.id} running；完成后 ${cli} reply ${request.id} done "<一句结果>"；失败 ${cli} reply ${request.id} failed "<原因>"；用户选跳过时 ${cli} reply ${request.id} skipped。画布上会显示这些状态。用户没点选项、自己打字回答的，按用户说的办，状态照样要回，不然画布上一直显示「请到对话里点执行」、还能点撤销。回完 done / failed / skipped，监听没在跑的话再后台启动它接下一条（reply 的结果会给命令）。`
  ]
}

function dutyLine(opened) {
  if (opened.page && opened.alreadyHeld) return `「${opened.page}」这一页本来就是你负责${folderWords(opened)}`
  return opened.page
    ? `你现在负责「${opened.page}」这一页${opened.pageCreated ? '（新建的）' : ''}${folderWords(opened)}${opened.takenFrom ? `，从「${opened.takenFrom}」那里接了过来` : ''}`
    : opened.myPage
      ? `你负责的还是「${opened.myPage}」这一页`
      : '你没负责任何页（用户说「打开 Cowart 画布 <页名>」或「接管 <页名>」时再进入）'
}

// Codex: a link the user opens in its built-in browser, and no listener (requests wait for 看画布).
function codexOpenResult(opened, cli) {
  const lines = [
    `Cowart 画布已就绪：${opened.url}`,
    `画布：${opened.canvasDir}（这台机器上所有会话、所有项目共用这一张，按页分工）`,
    `你在画布上的名字：${opened.sessionName}。${dutyLine(opened)}。`,
    '',
    '接下来：',
    opened.paneOpen
      ? '1. 这个会话的画布页已经开着，它会自动跳到这一页，不用重新打开。'
      : `1. 把网址写成可点的链接发给用户：[打开 Cowart 画布](${opened.url})。用户点开就在 Codex 的内置浏览器里看（也可以按 Ctrl+Shift+B 打开内置浏览器，再粘贴网址）。`,
    `2. 画布里点 AI 按钮（AI HTML、按标注修改这类）发来的请求不会叫醒你，在画布服务里排队：用户说「看画布」或答应要做时，${cli} requests 取，${cli} request <N> 看详情照做。`,
    `有哪些页：${cli} pages；你这页上有什么：${cli} page。不带 --page 的 put 放进你负责的页，没负责页时放进你的画布页正看着的页。`,
    ...[newPageFolderHint(opened, `${cli} folder <文件夹> "${opened.page}"`)].filter(Boolean)
  ]
  return textResult(lines.join('\n'), opened)
}

function codexTakeResult(opened, cli) {
  const lines = [
    `${dutyLine(opened)}。`,
    opened.paneOpen ? '你的画布页会自己跳到这一页。' : `这个会话还没打开画布：要看就 ${cli} open 拿网址，给用户可点的链接，在内置浏览器里打开。`,
    newPageFolderHint(opened, `${cli} folder <文件夹> "${opened.page}"`)
  ].filter(Boolean)
  return textResult(lines.join('\n'), opened)
}

// open: the canvas address and what to do next. No page list: `pages` has it.
function openResult(opened, cli, host = 'claude') {
  if (host === 'codex') return codexOpenResult(opened, cli)
  const command = `${cli} listen`
  const lines = [
    `Cowart 画布已就绪：${opened.url}`,
    `画布：${opened.canvasDir}（这台机器上所有会话、所有项目共用这一张，按页分工）`,
    `你在画布上的名字：${opened.sessionName}。${dutyLine(opened)}。`,
    '',
    '接下来：',
    opened.paneOpen
      ? '1. 这个会话的画布面板已经开着，它会自动跳到这一页，不用重新打开。'
      : '1. 在 Browser 面板打开上面的网址（mcp__Claude_Browser__preview_start，参数 url）。没有 Browser 面板时把网址发给用户，在浏览器里打开。',
    opened.listenerConnected
      ? '2. 这个会话的画布请求监听已经连着，不要重复启动。'
      : `2. 用 Bash 工具后台启动画布请求监听（run_in_background: true，description: "Cowart 画布请求"），命令：\n   ${command}\n   它一直等着、不耗 token，画布上真来了请求才退出，退出的通知会叫醒你（通知里只有输出文件路径：先 Read 它，照里面那行用 AskUserQuestion 问用户）；处理完再这样启动一次接下一条。它连着就表示这个会话在线，你负责的页一直归你。别用 Monitor 跑它：Monitor 最多 30 分钟，到点就会叫醒会话。`,
    `画布里点 AI 按钮时就是这样叫醒你的：「Cowart 画布请求 #N」→ 先问用户，用户选了要做再 ${cli} request <N> 看详情照做。监听没在跑时请求在服务里排队，用户说「看画布」时用 ${cli} requests 取。`,
    `有哪些页：${cli} pages；你这页上有什么：${cli} page。不带 --page 的 put 放进你负责的页，没负责页时放进你的画布面板正看着的页。`,
    ...[newPageFolderHint(opened, `${cli} folder <文件夹> "${opened.page}"`)].filter(Boolean)
  ]
  return textResult(lines.join('\n'), { ...opened, listenCommand: command })
}

// take: whose page it is now; the pane follows (no address, no listener: open said those).
function takeResult(opened, cli, host = 'claude') {
  if (host === 'codex') return codexTakeResult(opened, cli)
  const lines = [
    `${dutyLine(opened)}。`,
    opened.paneOpen ? '你的画布面板会自己跳到这一页。' : `这个会话还没开画布面板：要看就 ${cli} open 拿网址。`,
    opened.listenerConnected ? '' : `画布请求监听没在跑：用 Bash 工具后台运行 ${cli} listen（run_in_background: true）。`,
    newPageFolderHint(opened, `${cli} folder <文件夹> "${opened.page}"`)
  ].filter(Boolean)
  return textResult(lines.join('\n'), { ...opened, listenCommand: `${cli} listen` })
}

function requestDetails(request, cli, host = 'claude') {
  const notes = hostNotes(request, cli, host)
  const text = [
    `画布请求 #${request.id}「${request.title}」 状态：${request.status}${request.pageName ? `，来自「${request.pageName}」这一页` : ''}`,
    '',
    '—— 画布发来的原始请求 ——',
    request.text,
    '',
    host === 'codex' ? '—— Codex 宿主说明 ——' : '—— Claude Code 宿主说明 ——',
    ...notes.map((note) => `- ${note}`)
  ].join('\n')
  return textResult(text, { ...request, hostNotes: notes })
}

// pages [文件夹]: the whole canvas, or one folder with its subfolders (50 pages on 2026-10-22,
// most of them none of the session's business).
function pagesResult({ pages: all, myPageId, shownPageId }, cli, wantedFolder = null) {
  const nameOf = (id) => all.find((page) => page.id === id)?.name
  const folder = wantedFolder === null ? '' : normalizeFolder(wantedFolder)
  const pages = folder ? all.filter((page) => page.folder === folder || page.folder.startsWith(`${folder}/`)) : all
  if (folder && pages.length === 0) {
    const folders = [...new Set(all.map((page) => page.folder.split('/')[0]).filter(Boolean))]
    throw new UsageError(`没有叫「${folder}」的文件夹${folders.length > 0 ? `（顶层的文件夹：${folders.join('、')}）` : '（画布上还没有文件夹）'}；看一页上有什么用 ${cli} page <页名>。`)
  }
  const head = [
    folder ? `文件夹「${folder}」里有 ${pages.length} 页（整张画布 ${all.length} 页）` : `这张画布有 ${pages.length} 页`,
    myPageId ? `你负责「${nameOf(myPageId)}」` : '你没负责任何页',
    ...(shownPageId && shownPageId !== myPageId ? [`你的画布面板正看着「${nameOf(shownPageId)}」`] : [])
  ].join('，')
  // Folders as the page menu shows them: «数码宝贝/（25 页）», their pages indented under them.
  const lines = pageTreeLines(pages, (page) => {
    const who = page.mine ? '你负责' : page.holder ? `${page.holder}负责` : '没人负责'
    return `「${page.name}」 ${page.id} · ${page.shapes} 个图形 · ${who}${page.shown ? ' · 面板正看着' : ''}`
  })
  const foldered = all.some((page) => page.folder)
  return textResult(
    [
      `${head}：`,
      ...lines,
      '',
      `看一页上有什么：${cli} page <页名>（不给页名就是你负责的页）。`,
      `${foldered && !folder ? `页多时 ${cli} pages <文件夹> 只列一个文件夹；` : ''}用户要你给页归类时：${cli} folder <文件夹> <页名>…`
    ].join('\n'),
    { pages, myPageId, shownPageId }
  )
}

const detailsCommand = (cli) => (id) => `运行 ${cli} request ${id}`

// What Codex's prompt hook adds to the user's message when requests wait for the session: a
// reminder, not the requests (D10). The user's message comes first; the requests are done when the
// user says 看画布 or yes. Nothing when nothing waits.
export function hookReminder(requests, cli = cowartCommand('codex')) {
  if (!Array.isArray(requests) || requests.length === 0) return ''
  const line = (request) => {
    const where = [request.pageName ? `来自「${request.pageName}」这一页` : '', request.status === 'running' ? '你已回过 running，做完回 done / failed' : ''].filter(Boolean).join('，')
    return `- #${request.id}「${request.title}」${where ? `（${where}）` : ''}：${cli} request ${request.id}`
  }
  return [
    `Cowart 画布上有 ${requests.length} 条请求在等这个会话（用户在画布上点的，不是这条消息说的）：`,
    ...requests.map(line),
    `先回答用户这条消息。它跟画布无关时，在回复末尾提一句这些请求、问要不要做；用户说「看画布」或答应要做时，运行 ${cli} requests 取出来，再照每条后面的 request 命令看详情照做（还没读过 cowart skill 的话先读它）。`
  ].join('\n')
}

// ---- Running --------------------------------------------------------------------------

const HOOK_TIMEOUT_MS = 2_500
// The first service that answers hook-check: an older one would take the thread for a session of
// its own (a command session it keeps online) before it says it does not know the operation.
const HOOK_SERVICE_SINCE = '0.3.0'

// `hook prompt`: Codex runs it for every message the user sends (UserPromptSubmit), with the turn as
// JSON on stdin, and adds what it prints to the message (D9). It goes to the service the canvas lock
// names (canvas-lock.mjs: its pid runs) and only connects: looking for one the way a command does
// binds the ports it tries, and a service starting at logon that moment finds its port taken and
// gives up. It starts none, makes no session (hook-check in server.mjs), and prints nothing when
// there is nothing to remind of, no lock, or anything goes wrong or takes more than 2.5 s: the
// user's message must not wait.
async function promptHook(cli) {
  setTimeout(() => process.exit(0), HOOK_TIMEOUT_MS)
  try {
    let input = null
    try {
      input = JSON.parse(await readStdin())
    } catch {
      // No turn on stdin: the environment may still say whose it is.
    }
    const session = hookSessionId(process.env, input)
    if (!session) return exit(0)
    const owner = canvasOwner(SHARED_CANVAS_DIR)
    if (!Number.isInteger(owner?.port)) return exit(0)
    const token = await loadOrCreateToken()
    const found = await probeService(owner.port, token, { bind: false })
    if (found.kind !== 'cowart' || !found.status.version || compareVersions(found.status.version, HOOK_SERVICE_SINCE) < 0) return exit(0)
    const response = await fetch(`http://127.0.0.1:${owner.port}/api/bridge/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cowart-token': token },
      body: JSON.stringify({ session, op: 'hook-check', cli: true, host: 'codex' })
    })
    if (!response.ok) return exit(0)
    const { result } = await response.json()
    return exit(0, hookReminder(result?.requests, cli))
  } catch {
    return exit(0)
  }
}

function newClient(session, host) {
  return new CanvasServiceClient({
    host,
    session,
    cwd: process.cwd(),
    port: Number(process.env.COWART_CLAUDE_PORT) || DEFAULT_PORT,
    command: true,
    log: (message) => process.env.COWART_DEBUG && process.stderr.write(`[cowart] ${message}\n`)
  })
}

// Every tool a session has: the ones here and the canvas service's (upstream's insert and
// selection tools, the layout tools, send_cowart_feedback).
async function listTools(client) {
  const forwarded = (await client.call('model-tools')).tools
  const [render, canvasState, ...rest] = OWN_TOOLS
  return [render, canvasState, ...forwarded, ...rest]
}

async function toolSchema(client, name, host = 'claude') {
  const own = OWN_TOOLS.find((tool) => tool.name === name)
  if (own) return own.inputSchema
  const tool = (await listTools(client)).find((entry) => entry.name === name)
  if (!tool) throw new UsageError(`没有叫 ${name} 的工具（${commandLinkShown(host)} tools 列出全部）。`)
  return tool.inputSchema ?? { type: 'object', properties: {} }
}

// A page by name or id; null when there is no such page.
async function findPage(client, wanted) {
  const listing = await client.call('pages')
  const value = String(wanted).trim()
  const page = listing.pages.find((entry) => entry.id === value || entry.name === value)
    ?? listing.pages.find((entry) => entry.name.toLowerCase() === value.toLowerCase())
  return { page, listing }
}

async function pageIdFor(client, wanted, cli) {
  const { page } = await findPage(client, wanted)
  if (!page) throw new UsageError(`画布上没有叫「${wanted}」的页（${cli} pages 列出所有页；要新建就 ${cli} take ${wanted}）。`)
  return page.id
}

// One page's contents: the named one, else the one this session holds, else the one its pane shows.
async function pageSummary(client, wanted, cli) {
  let pageId
  if (wanted) {
    pageId = await pageIdFor(client, wanted, cli)
  } else {
    const { myPageId, shownPageId } = await client.call('pages')
    pageId = myPageId ?? shownPageId
    if (!pageId) throw new UsageError(`你没负责任何页，画布面板也没在看哪一页：${cli} pages 看有哪些页，${cli} page <页名> 看某一页。`)
  }
  return client.call('canvas-state', { pageId })
}

export async function callTool(client, name, args, cli = cowartCommand(), { as = 'open', ownAnchor = false, host = 'claude' } = {}) {
  // Codex runs no listener, so nothing tells it to start one again.
  const listenerNote = (listenerConnected) => (host !== 'codex' && listenerConnected === false ? restartListenerNote(`${cli} listen`) : null)
  switch (name) {
    case RENDER_TOOL: {
      const opened = await client.call('open-canvas', args)
      return as === 'take' ? takeResult(opened, cli, host) : openResult(opened, cli, host)
    }
    case CANVAS_STATE_TOOL:
      return client.call('canvas-state', args)
    case INSERT_VIDEO_TOOL:
      return client.call('insert-video', args)
    case GET_REQUEST_TOOL:
      return requestDetails((await client.call('request-get', { id: args.id })).request, cli, host)
    case REPLY_REQUEST_TOOL: {
      const { request: updated, listenerConnected } = await client.call('request-reply', { id: args.id, status: args.status, message: args.message })
      const lines = [`已把画布请求 #${updated.id} 标成 ${updated.status}${updated.message ? `：${updated.message}` : ''}`]
      // Done with this one: the next request needs the listener running again.
      if (updated.status !== 'running' && listenerNote(listenerConnected)) lines.push(listenerNote(listenerConnected))
      return textResult(lines.join('\n'), updated)
    }
    case LIST_REQUESTS_TOOL: {
      // Listed in the conversation (看画布): the requests still waiting come with their question
      // and, when no listener runs, how to start it again.
      const { requests, listenerConnected } = await client.call('request-list', { includeFinished: args.includeFinished === true, acknowledge: true })
      const none = args.includeFinished === true ? '这个会话还没有画布请求。' : '没有待处理的画布请求。'
      const lines = requests.length ? requests.map((request) => requestLine(request, { details: detailsCommand(cli), host })) : [none]
      if (listenerNote(listenerConnected)) lines.push('', listenerNote(listenerConnected))
      return textResult(lines.join('\n'), { requests, listenerConnected })
    }
    case 'get_cowart_selection':
      return as === 'selection' ? selectionResult(client, await client.call('tool', { name, arguments: args })) : client.call('tool', { name, arguments: args })
    default:
      return client.call('tool', { name, arguments: args, ...(ownAnchor ? { selectionAnchor: false } : {}) })
  }
}

// selection: the selected shapes as the page summary lists them (page position, frame, the
// file on this machine). The tool gives tldraw's records (positions inside their frame, the
// asset's address), which take a page summary more to use (2026-10-22).
async function selectionResult(client, result) {
  const shapes = result?.structuredContent?.selection?.selectedShapes ?? []
  if (result?.isError || shapes.length === 0) return result
  // The page the pane shows has them; a pane that has not said which page it shows yet (just
  // opened) leaves the whole canvas to look through.
  const { shownPageId } = await client.call('pages')
  const found = new Map()
  for (const pageId of [shownPageId ?? null, ...(shownPageId ? [null] : [])]) {
    let page = null
    for (const line of resultText(await client.call('canvas-state', pageId ? { pageId } : {})).split('\n')) {
      const header = /^页面「(.*)」\((page:[^)]+)\)/.exec(line)
      if (header) page = { name: header[1], id: header[2] }
      const shape = shapes.find((entry) => line.startsWith(`- ${entry.id} `))
      if (shape && !found.has(shape.id)) found.set(shape.id, { line, page })
    }
    if (found.size === shapes.length) break
  }
  const pageNames = [...new Set([...found.values()].map((entry) => entry.page?.name).filter(Boolean))]
  const lines = shapes.map((shape) => found.get(shape.id)?.line ?? `- ${shape.id} ${shape.type ?? ''}（画布上已经没有它了）`)
  return textResult(
    [`你的画布面板里选中了 ${shapes.length} 个图形${pageNames.length === 1 ? `（「${pageNames[0]}」这一页）` : ''}：`, ...lines].join('\n'),
    { selectedShapeIds: shapes.map((shape) => shape.id), pageId: [...found.values()][0]?.page?.id ?? shownPageId ?? null }
  )
}

// What a command prints: the result's words for the session (its lines name what it made or
// found: ids, positions, files). call adds the tool's structured result, as the tool gave it;
// --out json gives the whole result to any command. The canvas snapshot only when asked for.
export function formatResult(result, { command, out }) {
  if (out === 'json') return JSON.stringify(result)
  const text = resultText(result)
  const structured = result.structuredContent
  const wanted = command?.tool === CANVAS_STATE_TOOL ? Boolean(structured?.snapshot) : command?.structured || !command
  if (result.isError || !structured || !wanted) return text
  return `${text}\n\n结构化结果：${JSON.stringify(structured)}`
}

function usage(cli, host = 'claude') {
  const entry = (name, about) => `  ${name}\n      ${about}`
  const groups = ['会话', '页', '看', '放', '整理', '请求', '其它']
  const lines = [
    host === 'codex'
      ? `cowart ${VERSION}：Codex 里的 Cowart 画布（在 Codex 的终端命令里运行；做画布上的事之前先读 cowart skill）。`
      : `cowart ${VERSION}：Claude Code 桌面版里的 Cowart 画布（用 Bash 工具运行；做画布上的事之前先加载 cowart skill）。`,
    `用法：${cli} <命令> [参数]`
  ]
  for (const group of groups) {
    lines.push('', `${group}：`)
    for (const command of COMMANDS.filter((entry) => entry.group === group)) lines.push(entry(command.usage, command.about))
    for (const [inGroup, , name, about] of otherCommands(host)) if (inGroup === group) lines.push(entry(name, about))
  }
  lines.push(
    '',
    '每个命令都能用：',
    ...GLOBAL_FLAGS.map(([name, about]) => entry(name, about)),
    '',
    '位置参数 put 都一样：--at x,y 放到那里；--next-to <id> [--side right|left|below|above] 放在它旁边；--replace <AI 框> 替换框；--page <页名> 放进别的页。',
    `${cli} help <命令> 列出那个命令的全部参数（命令自己的参数之外，工具的其它参数照工具定义写成 --kebab-case 也能用）。`
  )
  return lines.join('\n')
}

function describeCommand(command, schema, cli) {
  // Sections, a blank line apart.
  const sections = [[`${cli} ${command.usage}`, command.about]]
  const own = Object.entries(command.flags ?? {})
  if (own.length > 0) sections.push(['参数：', ...own.map(([name, flag]) => `  --${name}${flag.kind === 'switch' ? '' : ` ${flag.arg}`}  ${flag.about}`)])
  const properties = schema?.properties ?? {}
  const itemProperties = command.item ? properties[command.item]?.items?.properties ?? {} : {}
  const others = otherFlags(command, schema)
  if (others.length > 0) {
    sections.push(['少用的参数：', ...others.map((key) => {
      const spec = properties[key] ?? itemProperties[key] ?? {}
      const arg = spec.enum ? spec.enum.join('|') : spec.type === 'number' || spec.type === 'integer' ? '<数>' : spec.type === 'boolean' ? '' : '<…>'
      return `  --${kebab(key)}${arg ? ` ${arg}` : ''}  ${PARAM_ABOUT[key] ?? spec.description ?? ''}`.trimEnd()
    })])
  }
  if (command.item) sections.push([`一次多条：--json '[${command.batchExample ?? '{…}'}, …]'：每条的键用上面的参数名（不带 --），工具 ${command.tool} 的 ${command.item} 字段名也认。`])
  if (command.tool) sections.push([`参数原本的定义：${cli} tools ${command.tool}`])
  return sections.map((lines) => lines.join('\n')).join('\n\n')
}

function describeOther([, , name, about], cli) {
  return `${cli} ${name}\n${about}`
}

function write(stream, text) {
  return new Promise((resolve) => stream.write(text.endsWith('\n') ? text : `${text}\n`, resolve))
}

async function exit(code, text, stream = code === 0 ? process.stdout : process.stderr) {
  if (text) await write(stream, text)
  process.exit(code)
}

// `put image a.png` is the command 「put image」; anything else is one word.
function splitCommand(argv) {
  const [first, second, ...rest] = argv
  if (first === 'put' || first === 'help') {
    if (first === 'put' && !second) throw new UsageError('put 后面写放什么：put image / put video / put html / put text。')
    if (first === 'put') return { name: `put ${second}`, rest }
    if (second === 'put' && rest[0]) return { name: 'help', rest: [`put ${rest[0]}`, ...rest.slice(1)] }
  }
  return { name: first, rest: [second, ...rest].filter((value) => value !== undefined) }
}

export async function main(argv = process.argv.slice(2)) {
  // A command waits for the service (one starting, a port that does not answer yet) on timers
  // fetch does not count as work (its timeouts are unref'd): with nothing else running, Node
  // would end the process in the middle. Every way out is exit().
  setInterval(() => {}, 60_000)
  const host = hostFromEnv()
  const cli = cowartCommand(host)
  // Set once a command (not call) has its arguments: its results speak in its words.
  let speaking = null
  try {
    const { name, rest } = splitCommand(argv)
    if (!name || name === '--help' || name === '-h' || (name === 'help' && rest.length === 0)) return exit(0, usage(cli, host))
    if (name === '--version') return exit(0, VERSION)
    // Codex's, before the desktop switch and the session check: it takes the thread from stdin (its
    // environment has no CODEX_THREAD_ID, so it speaks as Codex whatever hostFromEnv says).
    if (name === 'hook') {
      if (rest[0] !== 'prompt' || rest.length > 1) throw new UsageError(`用法：${cli} hook prompt（Codex 的提醒 hook 跑它，会话里不用自己跑）`)
      return promptHook(cowartCommand('codex'))
    }
    if (name === 'install') {
      const { ok, lines } = await installCowart()
      const shown = commandLinkShown(host)
      return exit(ok ? 0 : 1, [...lines, `会话里这样用：node ${shown} <命令>（node ${shown} help 看用法）。`].join('\n'))
    }
    if (name === 'uninstall') {
      const { ok, lines } = await removeCowart()
      return exit(ok ? 0 : 1, lines.join('\n'))
    }
    if (name.startsWith('put ') && !commandNamed(name)) throw new UsageError(`没有 ${name}：put 能放 image / video / html / text。`)

    // The desktop switch is Claude Code's: Codex opens the canvas in its built-in browser.
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    if (host === 'claude' && entrypoint && !isDesktopEntrypoint(entrypoint) && process.env.COWART_ALLOW_CLI !== '1') {
      return exit(2, `cowart（Cowart 画布）只在 Claude Code 桌面版里用：画布要在桌面版的 Browser 面板里打开。这个会话的入口是 ${entrypoint}，所以 cowart 不干活；要在这里用，设环境变量 COWART_ALLOW_CLI=1。`)
    }
    // Nothing wakes a Codex session: its requests wait until the user asks (看画布).
    if (name === 'listen' && host === 'codex') {
      return exit(2, `Codex 不用 listen：画布请求不会叫醒 Codex 会话，在画布服务里排队；用户说「看画布」或答应要做时，运行 ${cli} requests 取，${cli} request <编号> 看详情照做。`)
    }
    const session = sessionIdFromEnv()
    if (!session) {
      return exit(2, host === 'codex'
        ? 'cowart 找不到这个会话的标识（CODEX_THREAD_ID）：要在 Codex 会话的终端命令里运行；手动试用时设 COWART_SESSION_ID=<随便一个名字>。'
        : 'cowart 找不到这个会话的标识（CLAUDE_CODE_HOST_SESSION_ID）：要在 Claude Code 桌面版会话的 Bash 工具里运行；手动试用时设 COWART_SESSION_ID=<随便一个名字>。')
    }
    const client = newClient(session, host)

    if (name === 'listen') {
      let first = true
      await client.start()
      await listenForRequests({
        reopen: `重新打开画布（${cli} open），照结果再后台启动 ${cli} listen。`,
        details: detailsCommand(cli),
        debug: (line) => process.env.COWART_LISTEN_DEBUG && process.stderr.write(`${line}\n`),
        async target() {
          // After a drop: find the service again (a newer one may have replaced it).
          if (!first) await client.reconnect()
          first = false
          const query = new URLSearchParams({ session, presence: '1', host })
          return { url: `${client.origin}/api/agent-events?${query}`, token: client.token }
        }
      })
      return
    }

    if (name === 'tools') {
      const tools = await listTools(client)
      if (rest[0] && rest[0] !== '--out') {
        const tool = tools.find((entry) => entry.name === rest[0])
        if (!tool) return exit(2, `没有叫 ${rest[0]} 的工具。`)
        return exit(0, JSON.stringify(tool, null, 2))
      }
      if (rest.includes('json')) return exit(0, JSON.stringify({ tools }))
      return exit(0, tools.map((tool) => {
        const command = COMMANDS.find((entry) => entry.tool === tool.name && !entry.run)
        return `${tool.name}${command ? `（${cli} ${command.name}）` : ''}：${String(tool.description ?? '').split(/(?<=[.。])\s/)[0]}`
      }).join('\n'))
    }

    if (name === 'help') {
      const command = commandNamed(rest[0])
      if (!command && otherCommandNamed(rest[0], host)) return exit(0, describeOther(otherCommandNamed(rest[0], host), cli))
      if (rest[0] === 'put') return exit(0, COMMANDS.filter((entry) => entry.group === '放').map((entry) => `${cli} ${entry.usage}\n    ${entry.about}`).join('\n'))
      if (!command) return exit(2, `没有 ${rest[0]} 这个命令。\n\n${usage(cli, host)}`)
      return exit(0, describeCommand(command, command.tool ? await toolSchema(client, command.tool, host) : {}, cli))
    }

    if (name === 'pages' || name === 'page') {
      const { flags, positionals, out } = tokenize(rest, () => true)
      if (flags.length > 0) throw new UsageError(`${name} 没有参数${flags[0].name === 'help' ? '' : `（不认识 --${flags[0].name}）`}：${commandNamed(name).usage}`)
      const wanted = positionals.join(' ') || null
      const result = name === 'pages' ? pagesResult(await client.call('pages'), cli, wanted) : await pageSummary(client, wanted, cli)
      return exit(result.isError ? 1 : 0, formatResult(result, { command: commandNamed(name), out }), out === 'json' || !result.isError ? process.stdout : process.stderr)
    }

    let command = commandNamed(name)
    let toolName = command?.tool
    let toolArgv = rest
    if (name === 'call') {
      if (!rest[0]) throw new UsageError(`用法：${cli} call <工具名> [--json '{…}'] [--参数 值 …]`)
      toolName = rest[0]
      toolArgv = rest.slice(1)
      // Called by its tool name, it takes the tool's own parameters only.
      command = { name: 'call', tool: toolName, usage: `call ${toolName} …`, structured: true }
    }
    if (!toolName) throw new UsageError(`没有 ${name} 这个命令。\n\n${usage(cli, host)}`)
    // Only arguments need the parameters' definitions (the service has them for its tools).
    const needsSchema = toolArgv.some((arg) => arg !== '--out' && arg !== 'json') || name === 'call'
    const schema = needsSchema ? await toolSchema(client, toolName, host) : {}
    const { args, out, help } = await buildArguments(command, schema, toolArgv)
    if (help) return exit(0, describeCommand(command, schema, cli))
    if (command.result === 'take' && !String(args.page ?? '').trim() && args.shownPage !== true) throw new UsageError(`用法：${command.usage}`)
    if (missingSubject(command, args)) throw new UsageError(`用法：${cli} ${command.usage}`)
    if (name !== 'call') speaking = { entries: command.item && Array.isArray(args[command.item]) ? args[command.item].length : 1 }
    // --page takes a page name too.
    if (typeof args.pageId === 'string' && !args.pageId.startsWith('page:')) args.pageId = await pageIdFor(client, args.pageId, cli)
    const result = restate(toolName, await callTool(client, toolName, args, cli, { as: command.result, ownAnchor: command.ownAnchor === true, host }), speaking)
    return exit(result.isError ? 1 : 0, formatResult(result, { command, out }), out === 'json' || !result.isError ? process.stdout : process.stderr)
  } catch (error) {
    const raw = localizeError(error instanceof Error ? error.message : String(error))
    const message = speaking ? inCommandWords(raw, speaking.entries) : raw
    if (error instanceof UsageError) return exit(2, message)
    return exit(1, argv.includes('json') && argv.includes('--out') ? JSON.stringify(errorResult(message)) : message, argv.includes('--out') ? process.stdout : process.stderr)
  }
}
