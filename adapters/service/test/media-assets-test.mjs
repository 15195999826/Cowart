import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMediaAsset } from '../lib/media-assets.mjs'

test('native video cache revalidation detects replacements and changes between chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cowart-video-version-'))
  try {
    const directory = join(root, 'pages', 'page', 'assets')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'video.mp4')
    await writeFile(file, Buffer.alloc(1024 * 1024, 1))
    const args = { canvasDir: root, assetUrl: '/page-assets/page/video.mp4' }
    const first = await readMediaAsset(args)
    assert.ok(first.nextOffset > 0)
    const hit = await readMediaAsset({ ...args, ifVersion: first.version })
    assert.equal(hit.notModified, true)
    assert.equal(hit.dataBase64, undefined)
    await appendFile(file, Buffer.from([2]))
    assert.equal((await readMediaAsset({ ...args, ifVersion: first.version })).notModified, undefined)
    await assert.rejects(readMediaAsset({ ...args, offset: first.nextOffset, expectedVersion: first.version }), /文件发生变化/)
    await rm(file)
    await assert.rejects(readMediaAsset({ ...args, ifVersion: first.version }), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pictures are read with their version too, so the native widget can keep them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cowart-picture-version-'))
  try {
    const directory = join(root, 'pages', 'page', 'assets')
    await mkdir(directory, { recursive: true })
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 5, 7)
    await writeFile(join(directory, 'picture.png'), bytes)
    const args = { canvasDir: root, assetUrl: '/page-assets/page/picture.png' }
    const parts = []
    let read = await readMediaAsset(args)
    assert.equal(read.mimeType, 'image/png')
    assert.equal(read.totalBytes, bytes.length)
    parts.push(read.dataBase64)
    while (read.nextOffset != null) {
      read = await readMediaAsset({ ...args, offset: read.nextOffset, expectedVersion: read.version })
      parts.push(read.dataBase64)
    }
    assert.ok(Buffer.from(parts.join(''), 'base64').equals(bytes))
    assert.deepEqual(await readMediaAsset({ ...args, ifVersion: read.version }), { assetUrl: args.assetUrl, version: read.version, notModified: true })
    // HTML stays upstream's.
    await writeFile(join(directory, 'draft.html'), '<p>hi</p>')
    assert.equal(await readMediaAsset({ canvasDir: root, assetUrl: '/page-assets/page/draft.html' }), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
