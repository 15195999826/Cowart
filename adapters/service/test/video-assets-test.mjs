import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readVideoAsset } from '../lib/video-assets.mjs'

test('native video cache revalidation detects replacements and changes between chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cowart-video-version-'))
  try {
    const directory = join(root, 'pages', 'page', 'assets')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'video.mp4')
    await writeFile(file, Buffer.alloc(1024 * 1024, 1))
    const args = { canvasDir: root, assetUrl: '/page-assets/page/video.mp4' }
    const first = await readVideoAsset(args)
    assert.ok(first.nextOffset > 0)
    const hit = await readVideoAsset({ ...args, ifVersion: first.version })
    assert.equal(hit.notModified, true)
    assert.equal(hit.dataBase64, undefined)
    await appendFile(file, Buffer.from([2]))
    assert.equal((await readVideoAsset({ ...args, ifVersion: first.version })).notModified, undefined)
    await assert.rejects(readVideoAsset({ ...args, offset: first.nextOffset, expectedVersion: first.version }), /文件发生变化/)
    await rm(file)
    await assert.rejects(readVideoAsset({ ...args, ifVersion: first.version }), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
