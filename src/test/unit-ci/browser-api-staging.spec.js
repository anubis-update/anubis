const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createStaging } = require('../../app/lib/browser-api/staging')

const root = path.resolve('C:\\stage')
const file = (size = 5) => ({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, size })
const dir = () => ({ isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true, size: 0 })

function fake (map, real = (p) => p) {
  return {
    lstatSync (p) { if (!map[p]) throw new Error('ENOENT'); return map[p] },
    realpathSync: real
  }
}

test('resolves plain staged files and dirs inside the root', () => {
  const s = createStaging({ root, fsApi: fake({ [path.join(root, 'a.txt')]: file(), [path.join(root, 'ext1')]: dir() }) })
  assert.equal(s.resolveFile('a.txt').path, path.join(root, 'a.txt'))
  assert.equal(s.resolveDir('ext1'), path.join(root, 'ext1'))
  assert.deepEqual(s.resolveFiles([{ stagedId: 'a.txt' }]), [path.join(root, 'a.txt')])
})

test('rejects traversal, absolute paths, separators and bad ids', () => {
  const s = createStaging({ root, fsApi: fake({}) })
  for (const id of ['..', '../x', 'a/b', 'a\\b', 'C:\\x', '', '.hidden', 'x.', 'a'.repeat(200), null, 5]) {
    assert.throws(() => s.resolveFile(id), (e) => e.code === 'INVALID_REQUEST', String(id))
  }
})

test('rejects unknown, symlinks, wrong kind, oversize and realpath escapes', () => {
  const link = { ...file(), isSymbolicLink: () => true }
  const s = createStaging({
    root,
    maxFileBytes: 10,
    fsApi: fake({ [path.join(root, 'l')]: link, [path.join(root, 'd')]: dir(), [path.join(root, 'big')]: file(11), [path.join(root, 'esc')]: file() }, (p) => p.endsWith('esc') ? 'C:\\other\\esc' : p)
  })
  assert.throws(() => s.resolveFile('nope'), (e) => e.code === 'INVALID_REQUEST')
  assert.throws(() => s.resolveFile('l'), (e) => e.code === 'INVALID_REQUEST')
  assert.throws(() => s.resolveFile('d'), (e) => e.code === 'INVALID_REQUEST')
  assert.throws(() => s.resolveDir('big'), (e) => e.code === 'INVALID_REQUEST')
  assert.throws(() => s.resolveFile('big'), (e) => e.code === 'LIMIT_EXCEEDED')
  assert.throws(() => s.resolveFile('esc'), (e) => e.code === 'INVALID_REQUEST')
})

test('requires an absolute root', () => {
  assert.throws(() => createStaging({ root: 'rel' }), TypeError)
})
