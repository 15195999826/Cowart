// MCP Apps pages cannot hold a localhost SSE connection. They renew a pane lease while
// polling this bounded event log. A cursor belongs to one incarnation of one pane: after
// a restart, expiry or overflow the caller receives a fresh authoritative snapshot.
import { randomUUID } from 'node:crypto'

export class WidgetPanes {
  #panes = new Map()

  constructor({ leaseMs = 30_000, maxEvents = 256, onExpired = () => {} } = {}) {
    this.leaseMs = leaseMs
    this.maxEvents = maxEvents
    this.onExpired = onExpired
  }

  get size() {
    return this.#panes.size
  }

  get(id) {
    return this.#panes.get(id) ?? null
  }

  forSession(session) {
    return [...this.#panes.values()].filter((pane) => pane.session === session)
  }

  touch({ pane: id, session, canvasDir }) {
    let pane = this.#panes.get(id)
    if (pane && pane.session !== session) throw new Error('这个画布面板属于另一个会话。')
    const created = !pane
    if (!pane) {
      pane = { id, session, canvasDir, epoch: randomUUID(), next: 1, events: [], timer: null }
      this.#panes.set(id, pane)
    }
    clearTimeout(pane.timer)
    pane.timer = setTimeout(() => {
      this.#panes.delete(id)
      this.onExpired(pane)
    }, this.leaseMs)
    pane.timer.unref?.()
    return { pane, created }
  }

  send(pane, event, data) {
    pane.events.push({ sequence: pane.next++, event, data: structuredClone(data) })
    if (pane.events.length > this.maxEvents) pane.events.splice(0, pane.events.length - this.maxEvents)
  }

  broadcast(matches, event, data) {
    for (const pane of this.#panes.values()) if (matches(pane)) this.send(pane, event, data)
  }

  async poll(pane, cursor, snapshot) {
    const [epoch, rawSequence] = typeof cursor === 'string' ? cursor.split('/') : []
    const sequence = Number(rawSequence)
    const oldest = pane.events[0]?.sequence ?? pane.next
    const valid = epoch === pane.epoch && Number.isSafeInteger(sequence) && sequence >= oldest - 1 && sequence < pane.next
    if (!valid) {
      // Reuse the current log sequence as the watermark. The snapshot replaces missed
      // state, while future changes remain strictly after this returned cursor.
      const watermark = pane.next - 1
      return { events: await snapshot(), cursor: `${pane.epoch}/${watermark}` }
    }
    return {
      events: pane.events.filter((item) => item.sequence > sequence).map(({ event, data }) => ({ event, data })),
      cursor: `${pane.epoch}/${pane.next - 1}`
    }
  }

  close() {
    for (const pane of this.#panes.values()) clearTimeout(pane.timer)
    this.#panes.clear()
  }
}
