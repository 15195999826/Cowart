#!/usr/bin/env node
// Puts Cowart in the company library on 猛兽 (beast-home ADR-0038), so a colleague copies the
// library's borrow text to their own AI and the AI installs Cowart from the book's INSTALL.md.
// Everything comes from one commit's local release copy (make-release-copy.mjs,
// ~/.cowart/releases/<adapters version>-<short commit>; made first when it is missing), so
// uncommitted work never ships:
//
// 1. Package: the copy's files under one top folder cowart-<version>/ in cowart-<version>.zip (file
//    times set to the commit time), put in the 猛兽 pickup locker, section `cowart`, with a note that
//    carries the release manifest's sha256. The zip bytes differ from run to run (bsdtar on Windows
//    also writes creation times), so a package of that name already in the locker counts as this one
//    when its note has the same manifest sha256 and is skipped; another manifest stops the run (the
//    files changed without a new version: bump-release.mjs first).
// 2. Book: adapters/claude/skills/cowart/SKILL.md with `version: <version>` in its front matter, and
//    adapters/claude/beast-library/INSTALL.md with {{VERSION}} and {{COMMIT}} filled in. The install
//    notes offer two kinds, one per machine: 省心版 (this package, not to be edited) and 开发版 (a clone
//    of the public GitHub repo reset to {{COMMIT}} with its remote removed, the colleague's own from
//    then on), so the commit has to be on origin/main.
// 3. `beast skill put` the book. The package goes up before the book: the other way round a colleague
//    could borrow a book whose package is not in the locker yet.
//
//   node adapters/scripts/publish-beast-library.mjs [<commit>] [--book-rev <n>] [--dry-run]
//
// --book-rev <n> republishes the book alone after INSTALL.md / SKILL.md wording changes: the library
// refuses changed content under the same version, so the book becomes <version>.<n> (0.2.13.1 sorts
// after 0.2.13) while the package and the install notes stay on <version>.
//
// --dry-run builds the package and the book in a temporary folder, prints where they are and stops.
// The beast CLI is found at COWART_BEAST_CLI, else ~/.beast/bin/beast.mjs (as the canvas service finds it).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SECTION = 'cowart'
const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const revAt = args.indexOf('--book-rev')
const BOOK_REV = revAt === -1 ? null : args.splice(revAt, 2)[1]
if (BOOK_REV !== null && !/^[1-9]\d*$/.test(BOOK_REV ?? '')) throw new Error('--book-rev takes a positive whole number')
const [commit = 'HEAD'] = args.filter((arg) => arg !== '--dry-run')

const git = (args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim()
const full = git(['rev-parse', '--verify', `${commit}^{commit}`])
const committedAt = new Date(Number(git(['show', '-s', '--format=%ct', full])) * 1000)
const manifestRaw = execFileSync('git', ['-C', REPO_ROOT, 'cat-file', 'blob', `${full}:adapters/generated/release-manifest.json`])
const manifest = JSON.parse(manifestRaw.toString('utf8'))
const version = manifest.version
const copyDir = join(homedir(), '.cowart', 'releases', `${version}-${full.slice(0, 7)}`)
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')
const manifestSha = sha(manifestRaw)

const beastCli = process.env.COWART_BEAST_CLI || join(homedir(), '.beast', 'bin', 'beast.mjs')
const beast = (args) => execFileSync(process.execPath, [beastCli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

if (!existsSync(copyDir)) execFileSync(process.execPath, [join(REPO_ROOT, 'adapters/scripts/make-release-copy.mjs'), full], { stdio: 'inherit' })
const origin = JSON.parse(readFileSync(join(copyDir, 'release-origin.json'), 'utf8'))
if (origin.commit !== full || origin.version !== version) throw new Error(`${copyDir} is not the release copy of ${full.slice(0, 7)} (${origin.commit?.slice(0, 7)} ${origin.version})`)

const work = mkdtempSync(join(tmpdir(), 'cowart-beast-'))
try {
  // 1. The package: the copy under cowart-<version>/, file times pinned to the commit.
  const top = `cowart-${version}`
  const staged = join(work, 'pkg', top)
  cpSync(copyDir, staged, { recursive: true })
  const pin = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) pin(path)
      utimesSync(path, committedAt, committedAt)
    }
  }
  pin(staged)
  utimesSync(staged, committedAt, committedAt)
  const zipName = `${top}.zip`
  const zip = join(work, zipName)
  // bsdtar writes zip on Windows 10+ and macOS (-a picks the format from the .zip suffix); Git Bash's
  // GNU tar on PATH cannot, so Windows uses the system one.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', join(work, 'pkg'), top], { stdio: 'inherit' })
  const zipSha = sha(readFileSync(zip))

  // 2. The book.
  const book = join(work, 'book', 'cowart')
  mkdirSync(book, { recursive: true })
  const skill = readFileSync(join(REPO_ROOT, 'adapters/claude/skills/cowart/SKILL.md'), 'utf8')
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)
  if (!front) throw new Error('adapters/claude/skills/cowart/SKILL.md has no front matter')
  const fields = front[1].split('\n').filter((line) => !line.startsWith('version:'))
  const at = fields.findIndex((line) => line.startsWith('name:'))
  fields.splice(at + 1, 0, `version: ${BOOK_REV ? `${version}.${BOOK_REV}` : version}`)
  writeFileSync(join(book, 'SKILL.md'), `---\n${fields.join('\n')}\n---\n${skill.slice(front[0].length)}`)
  const install = readFileSync(join(REPO_ROOT, 'adapters/claude/beast-library/INSTALL.md'), 'utf8')
  // {{COMMIT}}: the 开发版 path clones the GitHub repo and resets to this commit, so origin/main must have it
  if (!git(['branch', '-r', '--contains', full]).split('\n').some((line) => line.trim() === 'origin/main')) {
    throw new Error(`${full.slice(0, 7)} is not on origin/main yet: push it first (the book's 开发版 clones GitHub and resets to it)`)
  }
  writeFileSync(join(book, 'INSTALL.md'), install.replaceAll('{{VERSION}}', version).replaceAll('{{COMMIT}}', full))
  const note = join(work, 'note.md')
  writeFileSync(note, [
    `# Cowart ${version}（Claude Code 桌面版运行包）`,
    '',
    `提交 \`${full.slice(0, 7)}\`（${committedAt.toISOString()}），build \`${manifest.serviceBuild}\`，发布清单 sha256 \`${manifestSha}\`。`,
    '',
    '图书馆《cowart》的安装说明用它：解压到 `~/.cowart/releases/`，再把 MCP 指到里面的 `adapters/generated/cowart-claude-mcp.mjs`。只有运行件（发布清单里的文件），不含源码，不用 npm install。',
    ''
  ].join('\n'))

  console.log(`package ${zipName}: ${(statSync(zip).size / 1024 / 1024).toFixed(1)} MB, sha256 ${zipSha}`)
  if (DRY_RUN) {
    console.log(`dry run, nothing uploaded; package ${zip}, book ${book}`)
    process.exitCode = 0
  } else {
    // 1b. Into the locker, unless this exact package is already there.
    const locker = JSON.parse(beast(['locker', 'ls', SECTION, '--json']))
    const there = locker.sections?.find((section) => section.id === SECTION)?.items?.find((item) => item.name === zipName)
    if (there && !String(there.note ?? '').includes(manifestSha)) {
      throw new Error(`locker ${SECTION}/${zipName} is already there from another release manifest; the files changed without a new version: run bump-release.mjs and publish again`)
    }
    if (there) console.log(`locker ${SECTION}/${zipName} already has this package`)
    else process.stdout.write(beast(['locker', 'put', zip, '--to', SECTION, '--note', note]))
    // 3. The book.
    process.stdout.write(beast(['skill', 'put', book, '--ai', 'claude-code']))
  }
} finally {
  if (!DRY_RUN) rmSync(work, { recursive: true, force: true })
}
