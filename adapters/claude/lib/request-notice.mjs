// The line the listener prints for each canvas request (Claude Code's Monitor, ZCode's --once
// run). Claude asks the user before any other call — a canvas request is a background event,
// not the user's words — so the line carries what that question needs: the choices that fit
// the request and, when it comes with 标注, their words. The bridges' host notes reuse the
// 按标注修改 wording.
import { requestTask } from '../../service/lib/requests.mjs'

const QUOTE_LENGTH = 60
const QUOTE_COUNT = 8
const CIRCLED = '①②③④⑤⑥⑦⑧'

// 按标注修改 is written as an image edit, but its 标注 are often remarks on what the picture
// shows (a screenshot of the user's project, a design) that call for answers and changes to
// the project rather than a new picture. Claude tells which from their words.
export const ANNOTATION_EDIT_QUESTION =
  '先看标注：要改这张图本身（换背景、改颜色这类）就推荐出新图；是对图里界面、功能、设计的意见或问题（图多是项目截图、设计稿）就推荐照标注处理，问题里一句话说出你的理解。选项（推荐的放第一个）：照标注处理（答疑、改当前项目，不生图）/ 按标注出新图（免费本地模型）/ 按标注出新图（云端，消耗团队额度）/ 跳过'

export const ANNOTATION_REMARKS_NOTE =
  '用户选「照标注处理」时：标注是对图里内容的意见或问题，不是改图要求——不生图、不往画布放图，原始请求里让你生成新图、放到原图旁边的那几句这时不适用。Read 带标注的截图，在对话里逐条回答问题，要改的地方在当前项目里改（改动大的先跟用户对一下），做完 reply done，message 写一句（比如「已在对话里逐条答复」）。'

function quote(text) {
  const words = String(text ?? '').trim()
  if (!words) return '（没写字）'
  return `「${words.length > QUOTE_LENGTH ? `${words.slice(0, QUOTE_LENGTH)}…` : words}」`
}

function quoteAll(items, numbered) {
  const quoted = items
    .slice(0, QUOTE_COUNT)
    .map((item, index) => `${numbered ? CIRCLED[index] : ''}${quote(item.text)}`)
    .join('')
  return items.length > QUOTE_COUNT ? `${quoted}…` : quoted
}

// 标注 say what to change; 注释 are background that stays.
function annotationWords(annotations) {
  const changes = annotations.filter((item) => !item.note)
  const notes = annotations.filter((item) => item.note)
  return [
    ...(changes.length ? [`${changes.length} 条标注：${quoteAll(changes, true)}`] : []),
    ...(notes.length ? [`${notes.length} 条注释（常驻说明）：${quoteAll(notes, false)}`] : [])
  ].join('；')
}

export function requestNotice(request) {
  const page = request.page ? `（页「${request.page}」）` : ''
  const about = request.annotations?.length ? annotationWords(request.annotations) : request.summary
  const head = `Cowart 画布请求 #${request.id}「${request.title}」${page}${about ? `：${about}` : ''}`
  // Any answer but 跳过 goes ahead, the user's own words included; the request then gets its
  // status like any other, or the canvas keeps asking for 执行 and offering 撤销.
  const proceed = `选了跳过以外的再调 get_cowart_request {"id": ${request.id}} 看详情照做（用户自己打字回答也算，按用户说的办）`
  const task = requestTask(request)
  if (task === 'annotation-edit') {
    return `${head} → 马上用 AskUserQuestion 问用户一句。${ANNOTATION_EDIT_QUESTION}。${proceed}`
  }
  const options = task === 'generate-image' ? '执行（免费本地模型）/ 执行（云端，消耗团队额度）/ 跳过' : '执行 / 跳过'
  return `${head} → 马上用 AskUserQuestion 问用户一句（${options}），${proceed}`
}
