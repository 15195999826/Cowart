// Claude Code side of the Cowart canvas: the cowart command (bin/cowart.mjs), which sessions run
// with the Bash tool; the cowart skill (skills/cowart) says when and how. The canvas runs in the
// machine-wide canvas service (adapters/service), which serves it on localhost for the Browser
// pane, makes one session at a time responsible for each page and routes a page's requests to
// that session. Each command finds the service (starts it, replaces one running older code),
// makes one call and leaves; `cowart listen`, run in the background, brings the session its
// canvas requests and keeps it online while it runs (server.mjs). It used to be an MCP server,
// registered project by project, and the session was online only while that process lived.
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { CanvasServiceClient } from '../../service/client.mjs'
import { DEFAULT_PORT, VERSION, samePath } from '../../service/lib/identity.mjs'
import { AGENT_STATUSES, requestTask } from '../../service/lib/requests.mjs'
import { ADAPTERS_DIR } from '../../shared/paths.mjs'
import { listenForRequests } from './listen.mjs'
import { ANNOTATION_EDIT_QUESTION, ANNOTATION_REMARKS_NOTE, requestLine, restartListenerNote } from './request-notice.mjs'
import { CANVAS_STATE_TOOL, GET_REQUEST_TOOL, INSERT_VIDEO_TOOL, LIST_REQUESTS_TOOL, OWN_TOOLS, RENDER_TOOL, REPLY_REQUEST_TOOL } from './tools.mjs'

const HOST = 'claude'
export const ENTRY = process.env.COWART_BUNDLED === '1'
  ? join(ADAPTERS_DIR, 'generated', 'cowart.mjs')
  : join(ADAPTERS_DIR, 'claude', 'bin', 'cowart.mjs')
// The command the skill names: a small file `cowart install` writes, leading to ENTRY (wherever
// this checkout or release is). COWART_COMMAND_LINK moves it (tests).
export const COMMAND_LINK = process.env.COWART_COMMAND_LINK || join(homedir(), '.cowart', 'bin', 'cowart.mjs')
const COMMAND_LINK_SHOWN = process.env.COWART_COMMAND_LINK ? COMMAND_LINK.replaceAll('\\', '/') : '~/.cowart/bin/cowart.mjs'

// The canvas needs the desktop's Browser pane; other entry points are turned away. Desktop
// builds other than the official one add a suffix to the entry point (the relay build sends
// claude-desktop-3p) and have the same Browser pane, so they count as the desktop too.
const DESKTOP_ENTRYPOINT = 'claude-desktop'

export function isDesktopEntrypoint(entrypoint) {
  return entrypoint === DESKTOP_ENTRYPOINT || String(entrypoint).startsWith(`${DESKTOP_ENTRYPOINT}-`)
}

// The desktop gives the commands a session runs its session id (its Bash tool's environment, as
// it gave its MCP servers): it outlives a resumed session, so the pages it opened reconnect to
// it. Tests and the dev host set COWART_SESSION_ID.
export function sessionIdFromEnv(env = process.env) {
  const raw = env.COWART_SESSION_ID || env.CLAUDE_CODE_HOST_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || ''
  return String(raw).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 96) || null
}

// The file `install` wrote leads to this entry.
function linkTarget() {
  try {
    const match = /^const target = (".*")$/m.exec(readFileSync(COMMAND_LINK, 'utf8'))
    return match ? JSON.parse(match[1]) : null
  } catch {
    return null
  }
}

// How texts tell the session to run cowart.
export function cowartCommand() {
  return samePath(linkTarget(), ENTRY) ? `node ${COMMAND_LINK_SHOWN}` : `node "${ENTRY.replaceAll('\\', '/')}"`
}

export async function installCommandLink() {
  const target = ENTRY.replaceAll('\\', '/')
  const source = [
    '#!/usr/bin/env node',
    '// The cowart command of Claude Code sessions (see the cowart skill), written by `cowart install`.',
    '// It runs the Cowart checkout or release below; installing another one rewrites this file.',
    "import { existsSync } from 'node:fs'",
    "import { pathToFileURL } from 'node:url'",
    '',
    `const target = ${JSON.stringify(target)}`,
    'if (!existsSync(target)) {',
    "  process.stderr.write(`cowart 命令指向的 ${target} 不在了：重新安装 Cowart（cowart skill 里写了怎么装）。\\n`)",
    '  process.exit(2)',
    '}',
    'await import(pathToFileURL(target).href)',
    ''
  ].join('\n')
  await mkdir(dirname(COMMAND_LINK), { recursive: true })
  await writeFile(COMMAND_LINK, source)
  return { link: COMMAND_LINK, target }
}

// Only the link to this entry: another checkout's is left alone.
export async function removeCommandLink() {
  const target = linkTarget()
  if (!existsSync(COMMAND_LINK)) return { removed: false, reason: '没有安装过' }
  if (!samePath(target, ENTRY)) return { removed: false, reason: `它指向的是 ${target ?? '别的东西'}，不是这一份` }
  await rm(COMMAND_LINK, { force: true })
  return { removed: true }
}

// ---- Commands -------------------------------------------------------------------------

// Each command runs one tool. positional: the parameters its arguments fill, in order ('...'
// takes the rest). item: a tool taking a list of these (insert_cowart_text's items,
// update_cowart_shapes' updates), whose flags make one entry. aliases: short flags.
const COMMANDS = [
  {
    name: 'open',
    tool: RENDER_TOOL,
    usage: 'open [--name <名字>] [--page <页名> | --shown-page]',
    about: '打开画布；--page 进入（接管）这一页，没有就建；--shown-page 接管面板正看着的页',
    aliases: { name: 'sessionName' }
  },
  { name: 'state', tool: CANVAS_STATE_TOOL, usage: 'state [--snapshot]', about: '画布摘要：每页的图形、位置、尺寸、素材本地路径、标注、谁负责哪页', aliases: { snapshot: 'includeSnapshot' } },
  { name: 'selection', tool: 'get_cowart_selection', usage: 'selection', about: '用户在本会话画布面板里选中的东西', structured: true },
  {
    name: 'insert-image',
    tool: 'insert_cowart_image',
    positional: ['imagePath'],
    usage: 'insert-image <图片路径> [--anchor <shape id>] [--placement right|left|below|above] [--x <x> --y <y>] [--page-id <页 id>]',
    about: '放图片；--anchor 传 AI 图片框 id 就替换它',
    aliases: { anchor: 'anchorShapeId' },
    structured: true
  },
  {
    name: 'insert-video',
    tool: INSERT_VIDEO_TOOL,
    positional: ['videoPath'],
    usage: 'insert-video <视频路径> [--anchor <shape id>] [--placement …] [--x <x> --y <y>] [--replace-holder <AI 视频框 id>]',
    about: '放视频；--replace-holder 替换 AI 视频框',
    aliases: { anchor: 'anchorShapeId', 'replace-holder': 'replaceHolderShapeId' },
    structured: true
  },
  {
    name: 'insert-html',
    tool: 'insert_cowart_html_draft',
    positional: ['htmlPath'],
    usage: 'insert-html <HTML 文件> [--draft <AI HTML 框 id>] [--anchor <shape id>] [--placement …] [--file-name <名字.html>]',
    about: '放 / 替换 HTML 草稿，给 Slides 加页',
    aliases: { draft: 'draftShapeId', anchor: 'anchorShapeId' },
    structured: true
  },
  {
    name: 'insert-text',
    tool: 'insert_cowart_text',
    positional: ['text'],
    item: 'items',
    usage: 'insert-text <文字> (--anchor <shape id> [--placement below] | --x <x> --y <y>) [--size s|m|l|xl] [--text-align middle]',
    about: "放文字：编号、标题、说明；一次放多条用 --json '{\"items\":[…]}'",
    aliases: { anchor: 'anchorShapeId', align: 'textAlign' },
    structured: true
  },
  {
    name: 'frame',
    tool: 'insert_cowart_frame',
    positional: ['name', '...shapeIds'],
    usage: 'frame <标题> <shape id>… [--padding 40]',
    about: '建分组框，把这些图形原地框进去',
    structured: true
  },
  {
    name: 'update',
    tool: 'update_cowart_shapes',
    item: 'updates',
    usage: 'update --shape <shape id> [--x <x> --y <y> | --dx --dy] [--w --h] [--text …] [--name …] [--frame-id <框 id>|page] [--fit]',
    about: "移动、改尺寸、改文字 / 框标题、进出分组框；一批一起改用 --json '{\"updates\":[…]}'",
    aliases: { shape: 'shapeId' },
    structured: true
  },
  {
    name: 'delete',
    tool: 'delete_cowart_shapes',
    positional: ['...shapeIds'],
    usage: 'delete <shape id>… [--delete-children]',
    about: '删除图形（页面上 Ctrl+Z 撤不回；删框默认留下里面的东西）',
    structured: true
  },
  { name: 'request', tool: GET_REQUEST_TOOL, positional: ['id'], usage: 'request <编号>', about: '画布请求的详情（原始请求 + 宿主说明）' },
  {
    name: 'reply',
    tool: REPLY_REQUEST_TOOL,
    positional: ['id', 'status', '...message'],
    usage: `reply <编号> ${AGENT_STATUSES.join('|')} [一句话]`,
    about: '回画布请求的状态，画布顶部照着显示'
  },
  { name: 'requests', tool: LIST_REQUESTS_TOOL, usage: 'requests [--all]', about: '本会话的画布请求（「看画布」：取排队的请求）', aliases: { all: 'includeFinished' } },
  {
    name: 'feedback',
    tool: 'send_cowart_feedback',
    positional: ['...text'],
    usage: 'feedback <用户原话> --title <一句话> --kind bug|friction|idea [--details …] [--shape-ids <id>,…] [--attachments <路径>,…]',
    about: '记下用户对 Cowart 本身的意见',
    structured: true
  }
]

const OTHER_COMMANDS = [
  ['listen', '画布请求监听：用 Bash 工具后台跑（run_in_background: true），来了请求才退出；它连着就表示这个会话在线'],
  ['call <工具名> [--json \'{…}\']', '直接调一个工具，参数照工具定义（请求里写的工具调用照搬到这里）'],
  ['tools [<工具名>]', '列出所有工具；给了工具名就打出它的参数定义'],
  ['help [<命令>]', '用法；给了命令就列出它的全部参数'],
  ['install / uninstall', `把 ${COMMAND_LINK_SHOWN} 指向这一份 Cowart / 删掉它`]
]

const GLOBAL_FLAGS = [
  ['--json <JSON 对象>', '整个参数对象（- 从标准输入读）；和其它选项一起给时选项优先'],
  ['--json-file <文件>', '从文件读参数对象（HTML 之类的长内容用它）'],
  ['--out json', '打出完整的结果 JSON，而不是给人读的文字']
]

function commandNamed(name) {
  return COMMANDS.find((command) => command.name === name || command.tool === name) ?? null
}

class UsageError extends Error {}

const kebab = (name) => name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
const camel = (name) => name.replace(/-([a-z])/g, (_, char) => char.toUpperCase())

// ---- Arguments ------------------------------------------------------------------------

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
  if (type === 'number' || type === 'integer') {
    const number = Number(value)
    if (value === '' || !Number.isFinite(number) || (type === 'integer' && !Number.isInteger(number))) throw new UsageError(`--${flag} 要一个${type === 'integer' ? '整数' : '数'}，「${value}」不是。`)
    return number
  }
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

function parseJson(text, what) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UsageError(`${what} 不是合法的 JSON：${error.message}`)
  }
}

// Splits the arguments into the parameter object (--json / --json-file), flags and positionals.
// A flag's value is the next argument, except for a flag that takes none (resolve tells).
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

// Where a flag goes: { key, schema, into: 'top' | 'item' } or null.
function flagSpec(command, schema, name) {
  const properties = schema?.properties ?? {}
  const itemProperties = command?.item ? properties[command.item]?.items?.properties ?? {} : {}
  const keyFor = (flag) => command?.aliases?.[flag] ?? (flag in properties || flag in itemProperties ? flag : camel(flag))
  const lookup = (flag) => {
    const key = keyFor(flag)
    if (key in properties && key !== command?.item) return { key, schema: properties[key], into: 'top' }
    if (key in itemProperties) return { key, schema: itemProperties[key], into: 'item' }
    return null
  }
  const spec = lookup(name)
  if (spec) return spec
  // --no-fit
  if (name.startsWith('no-')) {
    const negated = lookup(name.slice(3))
    if (negated?.schema?.type === 'boolean') return { ...negated, negated: true }
  }
  return null
}

function knownFlags(command, schema) {
  const properties = schema?.properties ?? {}
  const itemProperties = command?.item ? properties[command.item]?.items?.properties ?? {} : {}
  return [...Object.keys(properties).filter((key) => key !== command?.item), ...Object.keys(itemProperties)].map((key) => `--${kebab(key)}`)
}

async function readParameters(json, jsonFile) {
  let args = {}
  if (jsonFile) args = parseJson(await readFile(jsonFile, 'utf8'), `--json-file ${jsonFile}`)
  if (json !== null) {
    const text = json === '-' ? await readStdin() : json
    args = { ...args, ...parseJson(text, '--json') }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new UsageError('--json / --json-file 要一个 JSON 对象。')
  return args
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// The tool's parameters from the command line.
export async function buildArguments(command, schema, argv) {
  const parsed = tokenize(argv, (name) => {
    const spec = flagSpec(command, schema, name)
    // An unknown flag takes its value, to be turned away below.
    return !spec || (!spec.negated && spec.schema?.type !== 'boolean')
  })
  const args = await readParameters(parsed.json, parsed.jsonFile)
  const item = {}
  const put = (spec, value) => {
    const target = spec.into === 'item' ? item : args
    // A list flag given again adds to it.
    target[spec.key] = Array.isArray(value) && Array.isArray(target[spec.key]) && spec.fromFlag ? [...target[spec.key], ...value] : value
  }
  const given = new Set()
  for (const { name, value } of parsed.flags) {
    if (name === 'help') continue
    const spec = flagSpec(command, schema, name)
    if (!spec) {
      const known = knownFlags(command, schema)
      throw new UsageError(`不认识 --${name}。${known.length ? `能用的参数：${known.join(' ')}` : '这个命令没有参数。'}`)
    }
    const coerced = spec.negated ? !coerce(value, spec.schema, name) : coerce(value, spec.schema, name)
    put({ ...spec, fromFlag: given.has(spec.key) }, coerced)
    given.add(spec.key)
  }
  const positional = command?.positional ?? []
  const values = [...parsed.positionals]
  for (const slot of positional) {
    if (values.length === 0) break
    const rest = slot.startsWith('...')
    const key = rest ? slot.slice(3) : slot
    const spec = flagSpec(command, schema, key) ?? { key, schema: {}, into: 'top' }
    const taken = rest ? values.splice(0) : [values.shift()]
    const value = spec.schema?.type === 'array' ? taken.flatMap((entry) => coerce(entry, spec.schema, key)) : coerce(taken.join(' '), spec.schema, key)
    put(spec, value)
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

export function resultText(result) {
  return (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
}

const BACKGROUND_NOTICE = '这条请求来自画布的后台通知，不是用户在对话里说的话：还没问过用户的话，先用 AskUserQuestion 确认再执行。'

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
  const imagegen = `画布的提示词是按 Codex 写的：凡是要求用 Codex 内置 imagegen / 当前可用的图片生成能力的地方，改用 beast-gen skill（先用 Skill 工具加载它，按它的规则出图）。免费本地档：文生图用 krea2，按标注 / 参考图改图用 flux2-klein；云端档用 lib-image（Lib Image 2.5，quality=low 起步）。模板与参数以 beast gen templates 现查为准。结果下载到本地后，按请求里的要求放上画布：${cli} insert-image <本地路径> …（请求写给 insert_cowart_image 的参数照样带上）。`
  if (request.kind === 'video') {
    return `这是视频请求：先用 Skill 工具加载 beast-gen，按请求里写好的模板和参数提交，素材按请求的顺序上传后填进对应参数；生成后下载到本地，按请求放进画布：${cli} insert-video <本地路径> --replace-holder <AI 视频框的 id>。`
  }
  if (request.kind === 'image') {
    return `这是图片请求：先用 Skill 工具加载 beast-gen，按请求里的模板和参数出图，按 skill 的要求先读对应参考（lib-image 2.5 系读 references/image-prompting.md，ideogram4 读 references/ideogram4-caption.md，透明底读 references/transparent-asset.md）；生成后下载到本地，Read 看图，再按请求放进画布：${cli} insert-image <本地路径> …。`
  }
  if (request.kind === 'web') {
    return `这是网页复刻请求：先 Read 请求里的整页截图（很长时分段看），有标注的话逐张 Read 标注的局部截图，再读渲染后的页面代码；要看真实的颜色、字体、间距，或按坐标找标注指的元素，可以用 Browser 面板打开原网址（mcp__Claude_Browser__navigate，再用 read_page / javascript_tool 读计算后的样式、用 document.elementFromPoint 定位）。做成单文件 HTML 后按请求放进画布：${cli} insert-html <HTML 文件> --draft <框 id> …。`
  }
  const task = requestTask(request)
  if (task === 'annotation-edit') return `${ANNOTATION_REMARKS_NOTE}用户选「按标注出新图」时：${imagegen}`
  if (task === 'html') {
    return `AI HTML / AI Slides 请求：不生图、不用 beast-gen；照请求写完整的单文件 HTML（CSS / JS 内联），按请求放进画布：${cli} insert-html <HTML 文件> …。`
  }
  return imagegen
}

export function hostNotes(request, cli = cowartCommand()) {
  if (request.status === 'cancelled') {
    return ['用户已经在画布上撤销了这条请求：不要执行，也不用再问用户；正在问的话直接结束。']
  }
  return [
    confirmNote(request),
    '还没加载过 cowart skill 的话，先用 Skill 工具加载它：各类请求的做法、结果放哪一页、标注怎么读都在那里。',
    generationNote(request, cli),
    `请求里的工具调用是按 Codex 写的（insert_cowart_… 和它们的参数）：Claude Code 里用 cowart 命令跑——${cli} call <工具名> --json '{…}' 原样照搬参数（路径写成 / 分隔），或用对应的子命令加 --参数（${cli} help 列出子命令；参数写成短横线形式，比如 --anchor-shape-id）。长 HTML 先写成文件，再传文件路径。`,
    '请求里给出的截图、参考图等本地路径可以直接用 Read 工具查看。',
    `请求开头的 [@Cowart](plugin://…) 是 Codex 的插件提及，忽略即可；请求说不要调用 render_cowart_canvas_widget 时，就是不要重新 ${cli} open。`,
    ...(request.pageId
      ? [`结果放进发出请求的那一页：放的时候带上 --page-id ${request.pageId}（请求里指定了卡片的就按卡片放；这一页后来换了别的会话负责也照样放得进去）。`]
      : []),
    `开始执行时运行 ${cli} reply ${request.id} running；完成后 ${cli} reply ${request.id} done "<一句结果>"；失败 ${cli} reply ${request.id} failed "<原因>"；用户选跳过时 ${cli} reply ${request.id} skipped。画布上会显示这些状态。用户没点选项、自己打字回答的，按用户说的办，状态照样要回，不然画布上一直显示「请到对话里点执行」、还能点撤销。回完 done / failed / skipped，监听没在跑的话再后台启动它接下一条（reply 的结果会给命令）。`
  ]
}

function renderResult(opened, cli) {
  const command = `${cli} listen`
  const pageList = (opened.pages ?? []).map((page) => `「${page.name}」${page.holder ? `（${page.mine ? '你' : page.holder}负责）` : ''}`)
  const duty = opened.page
    ? `你现在负责「${opened.page}」这一页${opened.pageCreated ? '（新建的）' : ''}${opened.takenFrom ? `，从「${opened.takenFrom}」那里接了过来` : ''}`
    : opened.myPage
      ? `你负责的还是「${opened.myPage}」这一页`
      : '你没负责任何页（用户说「打开 Cowart 画布 <页名>」或「接管 <页名>」时再进入）'
  const lines = [
    `Cowart 画布已就绪：${opened.url}`,
    `画布：${opened.canvasDir}（这台机器上所有会话、所有项目共用这一张，按页分工）`,
    `你在画布上的名字：${opened.sessionName}。${duty}。`,
    ...(pageList.length > 0 ? [`这张画布的页：${pageList.join('、')}。每一页同一时间由一个会话负责：那一页的画布请求发给它，别的会话不能往那一页放东西。`] : []),
    '',
    '接下来：',
    opened.paneOpen
      ? '1. 这个会话的画布面板已经开着，它会自动跳到这一页，不用重新打开。'
      : '1. 在 Browser 面板打开上面的网址（mcp__Claude_Browser__preview_start，参数 url）。没有 Browser 面板时把网址发给用户，在浏览器里打开。',
    opened.listenerConnected
      ? '2. 这个会话的画布请求监听已经连着，不要重复启动。'
      : `2. 用 Bash 工具后台启动画布请求监听（run_in_background: true，description: "Cowart 画布请求"），命令：\n   ${command}\n   它一直等着、不耗 token，画布上真来了请求才退出，退出的通知会叫醒你（通知里只有输出文件路径：先 Read 它，照里面那行用 AskUserQuestion 问用户）；处理完再这样启动一次接下一条。它连着就表示这个会话在线，你负责的页一直归你。别用 Monitor 跑它：Monitor 最多 30 分钟，到点就会叫醒会话。`,
    `画布里点 AI 按钮时就是这样叫醒你的：「Cowart 画布请求 #N」→ 先问用户，用户选了要做再 ${cli} request <N> 看详情照做。监听没在跑时请求在服务里排队，用户说「看画布」时用 ${cli} requests 取。`,
    '之后的 cowart 命令都作用在这张画布上：不带 --page-id 的插入放进你负责的页，没负责页时放进你的画布面板正看着的页。'
  ]
  return textResult(lines.join('\n'), { ...opened, listenCommand: command })
}

function requestDetails(request, cli) {
  const notes = hostNotes(request, cli)
  const text = [
    `画布请求 #${request.id}「${request.title}」 状态：${request.status}${request.pageName ? `，来自「${request.pageName}」这一页` : ''}`,
    '',
    '—— 画布发来的原始请求 ——',
    request.text,
    '',
    '—— Claude Code 宿主说明 ——',
    ...notes.map((note) => `- ${note}`)
  ].join('\n')
  return textResult(text, { ...request, hostNotes: notes })
}

const detailsCommand = (cli) => (id) => `运行 ${cli} request ${id}`

// ---- Running --------------------------------------------------------------------------

function newClient(session) {
  return new CanvasServiceClient({
    host: HOST,
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

async function toolSchema(client, name) {
  const own = OWN_TOOLS.find((tool) => tool.name === name)
  if (own) return own.inputSchema
  const tool = (await listTools(client)).find((entry) => entry.name === name)
  if (!tool) throw new UsageError(`没有叫 ${name} 的工具（${COMMAND_LINK_SHOWN} tools 列出全部）。`)
  return tool.inputSchema ?? { type: 'object', properties: {} }
}

export async function callTool(client, name, args, cli = cowartCommand()) {
  switch (name) {
    case RENDER_TOOL:
      return renderResult(await client.call('open-canvas', args), cli)
    case CANVAS_STATE_TOOL:
      return client.call('canvas-state', args)
    case INSERT_VIDEO_TOOL:
      return client.call('insert-video', args)
    case GET_REQUEST_TOOL:
      return requestDetails((await client.call('request-get', { id: args.id })).request, cli)
    case REPLY_REQUEST_TOOL: {
      const { request: updated, listenerConnected } = await client.call('request-reply', { id: args.id, status: args.status, message: args.message })
      const lines = [`已把画布请求 #${updated.id} 标成 ${updated.status}${updated.message ? `：${updated.message}` : ''}`]
      // Done with this one: the next request needs the listener running again.
      if (listenerConnected === false && updated.status !== 'running') lines.push(restartListenerNote(`${cli} listen`))
      return textResult(lines.join('\n'), updated)
    }
    case LIST_REQUESTS_TOOL: {
      // Listed in the conversation (看画布): the requests still waiting come with their question
      // and, when no listener runs, how to start it again.
      const { requests, listenerConnected } = await client.call('request-list', { includeFinished: args.includeFinished === true, acknowledge: true })
      const lines = requests.length ? requests.map((request) => requestLine(request, { details: detailsCommand(cli) })) : ['没有待处理的画布请求。']
      if (listenerConnected === false) lines.push('', restartListenerNote(`${cli} listen`))
      return textResult(lines.join('\n'), { requests, listenerConnected })
    }
    default:
      return client.call('tool', { name, arguments: args })
  }
}

// What a command prints: the result's words for the session, then, for the commands that make
// or find shapes, the structured result (ids, bounds, file paths) the next command may need.
// The canvas snapshot only when it was asked for.
export function formatResult(result, { command, out }) {
  if (out === 'json') return JSON.stringify(result)
  const text = resultText(result)
  const structured = result.structuredContent
  const wanted = command?.structured || !command || (command.tool === CANVAS_STATE_TOOL && structured?.snapshot)
  if (result.isError || !structured || !wanted) return text
  return `${text}\n\n结构化结果：${JSON.stringify(structured)}`
}

function usage(cli) {
  const entry = (name, about) => `  ${name}\n      ${about}`
  return [
    `cowart ${VERSION}：Claude Code 桌面版里的 Cowart 画布（用 Bash 工具运行；做画布上的事之前先加载 cowart skill）。`,
    `用法：${cli} <命令> [参数]`,
    '',
    '命令：',
    ...COMMANDS.map((command) => entry(command.usage, command.about)),
    ...OTHER_COMMANDS.map(([name, about]) => entry(name, about)),
    '',
    '每个命令都能用：',
    ...GLOBAL_FLAGS.map(([name, about]) => entry(name, about)),
    '',
    '参数名照工具定义，写成短横线形式（anchorShapeId → --anchor-shape-id）；列表用逗号分隔或重复给；开关写 --fit / --no-fit。',
    `${cli} help <命令> 列出那个命令的全部参数。`
  ].join('\n')
}

function describeSchema(schema, command) {
  const properties = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  const line = (key, spec, prefix = '') => {
    const type = spec?.enum ? spec.enum.join('|') : spec?.type === 'array' ? `${spec.items?.type ?? ''} 列表` : spec?.type ?? ''
    return `  ${prefix}--${kebab(key)}${type ? ` <${type}>` : ''}${required.has(key) ? '（必填）' : ''}${spec?.description ? `  ${spec.description}` : ''}`
  }
  const lines = Object.entries(properties).filter(([key]) => key !== command?.item).map(([key, spec]) => line(key, spec))
  if (command?.item) {
    const itemSchema = properties[command.item]?.items ?? {}
    lines.push(`  ${command.item} 的每一条（给这些选项就是一条；多条用 --json '{"${command.item}":[…]}'）：`)
    for (const [key, spec] of Object.entries(itemSchema.properties ?? {})) lines.push(line(key, spec, '  '))
  }
  if (command?.aliases) lines.push(`  简写：${Object.entries(command.aliases).map(([short, key]) => `--${short} = --${kebab(key)}`).join('，')}`)
  return lines.join('\n')
}

function write(stream, text) {
  return new Promise((resolve) => stream.write(text.endsWith('\n') ? text : `${text}\n`, resolve))
}

async function exit(code, text, stream = code === 0 ? process.stdout : process.stderr) {
  if (text) await write(stream, text)
  process.exit(code)
}

export async function main(argv = process.argv.slice(2)) {
  // A command waits for the service (one starting, a port that does not answer yet) on timers
  // fetch does not count as work (its timeouts are unref'd): with nothing else running, Node
  // would end the process in the middle. Every way out is exit().
  setInterval(() => {}, 60_000)
  const cli = cowartCommand()
  const [name, ...rest] = argv
  try {
    if (!name || name === '--help' || name === '-h' || (name === 'help' && rest.length === 0)) return exit(0, usage(cli))
    if (name === '--version') return exit(0, VERSION)
    if (name === 'install') {
      const { link, target } = await installCommandLink()
      return exit(0, `已安装 cowart 命令：${link} → ${target}\n会话里这样用：node ${COMMAND_LINK_SHOWN} <命令>（node ${COMMAND_LINK_SHOWN} help 看用法）。`)
    }
    if (name === 'uninstall') {
      const removed = await removeCommandLink()
      return exit(0, removed.removed ? `已删掉 ${COMMAND_LINK}。` : `没删 ${COMMAND_LINK}：${removed.reason}。`)
    }

    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    if (entrypoint && !isDesktopEntrypoint(entrypoint) && process.env.COWART_ALLOW_CLI !== '1') {
      return exit(2, `cowart（Cowart 画布）只在 Claude Code 桌面版里用：画布要在桌面版的 Browser 面板里打开。这个会话的入口是 ${entrypoint}，所以 cowart 不干活；要在这里用，设环境变量 COWART_ALLOW_CLI=1。`)
    }
    const session = sessionIdFromEnv()
    if (!session) {
      return exit(2, 'cowart 找不到这个会话的标识（CLAUDE_CODE_HOST_SESSION_ID）：要在 Claude Code 桌面版会话的 Bash 工具里运行；手动试用时设 COWART_SESSION_ID=<随便一个名字>。')
    }
    const client = newClient(session)

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
          const query = new URLSearchParams({ session, presence: '1', host: HOST })
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
        const command = COMMANDS.find((entry) => entry.tool === tool.name)
        return `${tool.name}${command ? `（${cli} ${command.name}）` : ''}：${String(tool.description ?? '').split(/(?<=[.。])\s/)[0]}`
      }).join('\n'))
    }

    if (name === 'help') {
      const command = commandNamed(rest[0])
      if (!command) return exit(2, `没有 ${rest[0]} 这个命令。\n\n${usage(cli)}`)
      return exit(0, `${cli} ${command.usage}\n${command.about}（工具 ${command.tool}）\n\n参数：\n${describeSchema(await toolSchema(client, command.tool), command)}`)
    }

    let command = commandNamed(name)
    let toolName = command?.tool
    let toolArgv = rest
    if (name === 'call') {
      if (!rest[0]) throw new UsageError(`用法：${cli} call <工具名> [--json '{…}'] [--参数 值 …]`)
      toolName = rest[0]
      toolArgv = rest.slice(1)
      command = commandNamed(toolName)
      // Called by its tool name, it takes the tool's parameters as they are.
      if (command) command = { ...command, positional: [], item: undefined, structured: command.structured }
    }
    if (!toolName) throw new UsageError(`没有 ${name} 这个命令。\n\n${usage(cli)}`)
    // Only flags and arguments need the parameters' definitions (the service has them for its tools).
    const needsSchema = toolArgv.some((arg) => arg !== '--out' && arg !== 'json') || name === 'call'
    const schema = needsSchema ? await toolSchema(client, toolName) : {}
    const { args, out, help } = await buildArguments(command, schema, toolArgv)
    if (help) return exit(0, `${cli} ${command?.usage ?? `call ${toolName} …`}\n\n参数：\n${describeSchema(schema, command)}`)
    const result = await callTool(client, toolName, args, cli)
    return exit(result.isError ? 1 : 0, formatResult(result, { command: command ?? null, out }), out === 'json' || !result.isError ? process.stdout : process.stderr)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof UsageError) return exit(2, message)
    return exit(1, argv.includes('json') && argv.includes('--out') ? JSON.stringify(errorResult(message)) : message, argv.includes('--out') ? process.stdout : process.stderr)
  }
}
