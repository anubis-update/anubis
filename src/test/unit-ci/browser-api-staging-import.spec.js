const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createStaging, ID_RE } = require('../../app/lib/browser-api/staging')

const root = path.resolve('C:\\stage')
const st = (o) => ({ isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false, size: 0, ...o })

function memFs (tree) {
  const copied = []
  const made = []
  return {
    copied,
    made,
    lstatSync (p) { if (!tree[p]) throw new Error('ENOENT'); return tree[p] },
    readdirSync: (d) => Object.keys(tree).filter((k) => path.dirname(k) === d).map((k) => path.basename(k)),
    mkdirSync: (p) => { made.push(p) },
    copyFileSync: (a, b) => { copied.push([a, b]) },
    rmSync: (p) => { made.push('rm:' + p) }
  }
}

test('importPath copies a file into the root under a generated id that resolves', () => {
  const src = path.resolve('D:\\u\\my doc!.txt')
  const fsApi = memFs({ [src]: st({ isFile: () => true, size: 7 }) })
  const s = createStaging({ root, fsApi })
  const r = s.importPath(src)
  assert.match(r.stagedId, /^st_[0-9a-f]{8}-my_doc_\.txt$/)
  assert.ok(ID_RE.test(r.stagedId))
  assert.deepEqual(fsApi.copied[0], [src, path.join(root, r.stagedId)])
  assert.equal(r.kind, 'file')
})

test('importPath copies folders recursively and refuses symlinks and relative paths', () => {
  const d = path.resolve('D:\\ext')
  const ok = memFs({
    [d]: st({ isDirectory: () => true }),
    [path.join(d, 'manifest.json')]: st({ isFile: () => true, size: 10 }),
    [path.join(d, 'sub')]: st({ isDirectory: () => true }),
    [path.join(d, 'sub', 'a.js')]: st({ isFile: () => true, size: 5 })
  })
  const r = createStaging({ root, fsApi: ok }).importPath(d)
  assert.deepEqual([r.kind, r.files, r.size], ['dir', 2, 15])
  assert.equal(ok.copied.length, 2)

  const bad = memFs({ [d]: st({ isDirectory: () => true }), [path.join(d, 'l')]: st({ isSymbolicLink: () => true }) })
  assert.throws(() => createStaging({ root, fsApi: bad }).importPath(d), (e) => e.code === 'INVALID_REQUEST')
  assert.ok(bad.made.some((m) => String(m).startsWith('rm:')))
  assert.throws(() => createStaging({ root, fsApi: ok }).importPath('rel\\x'), (e) => e.code === 'INVALID_REQUEST')
  assert.throws(() => createStaging({ root, fsApi: memFs({ [d]: st({ isSymbolicLink: () => true }) }) }).importPath(d), (e) => e.code === 'INVALID_REQUEST')
})

test('importPath enforces the file size limit', () => {
  const src = path.resolve('D:\\big.bin')
  const s = createStaging({ root, maxFileBytes: 5, fsApi: memFs({ [src]: st({ isFile: () => true, size: 6 }) }) })
  assert.throws(() => s.importPath(src), (e) => e.code === 'LIMIT_EXCEEDED')
})
