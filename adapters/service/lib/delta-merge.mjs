// A canvas page saves by sending what changed in it since the stored canvas last agreed
// with it (adapters/claude/web/bridge.js): records to put and ids to remove. The service
// lays that delta over the stored snapshot, so a page that synced a while ago cannot undo
// what other pages and the model wrote in the meantime, and never deletes a page or a
// record it has not seen. Upstream's own saves replace the whole canvas (and delete every
// page missing from it); they are still used when a page sends no delta.

// JSON with object keys in a fixed order, so two copies of a record compare equal no
// matter which host serialized them.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function readDelta(value) {
  if (!value || typeof value !== 'object') return null
  const put = Array.isArray(value.put)
    ? value.put.filter((record) => record && typeof record === 'object' && typeof record.id === 'string' && typeof record.typeName === 'string')
    : []
  const remove = Array.isArray(value.remove) ? value.remove.filter((id) => typeof id === 'string') : []
  return { put, remove }
}

function dependencies(record) {
  if (record?.typeName === 'shape') return typeof record.parentId === 'string' ? [record.parentId] : []
  if (record?.typeName === 'binding') return [record.fromId, record.toId].filter((id) => typeof id === 'string')
  return []
}

// disk: the stored snapshot. incoming: the page's snapshot (its schema is kept). Returns
// the merged snapshot and the pages the delta removed.
export function applyDelta({ disk, incoming, delta }) {
  const store = { ...disk.store }
  for (const id of delta.remove) delete store[id]
  for (const record of delta.put) store[record.id] = record
  // A shape whose page (or parent card) another page deleted, a binding that lost an end.
  let pruned = true
  while (pruned) {
    pruned = false
    for (const [id, record] of Object.entries(store)) {
      if (!dependencies(record).some((dependency) => !store[dependency])) continue
      delete store[id]
      pruned = true
    }
  }
  const deletedPages = Object.values(disk.store)
    .filter((record) => record?.typeName === 'page' && !store[record.id])
    .map((record) => record.id)
  return { snapshot: { ...incoming, store }, deletedPages }
}
