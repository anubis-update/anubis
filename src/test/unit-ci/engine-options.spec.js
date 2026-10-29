const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  ENGINES,
  PROFILE_NOTE,
  normalizeEngine,
  isCdpEngine,
  buildEngineOptions
} = require('../../client/components/web/engine-options')

test('ENGINES lists the three supported engines', () => {
  assert.deepEqual(ENGINES, ['rbi', 'chrome', 'edge'])
})

test('normalizeEngine passes known engines and falls back to rbi', () => {
  assert.equal(normalizeEngine('rbi'), 'rbi')
  assert.equal(normalizeEngine('chrome'), 'chrome')
  assert.equal(normalizeEngine('edge'), 'edge')
  assert.equal(normalizeEngine('bogus'), 'rbi')
  assert.equal(normalizeEngine(undefined), 'rbi')
})

test('isCdpEngine is true only for chrome/edge', () => {
  assert.equal(isCdpEngine('chrome'), true)
  assert.equal(isCdpEngine('edge'), true)
  assert.equal(isCdpEngine('rbi'), false)
  assert.equal(isCdpEngine(undefined), false)
})

test('buildEngineOptions enables chrome/edge when entitled', () => {
  const opts = buildEngineOptions({ entitled: true })
  assert.deepEqual(opts.map(o => o.value), ['rbi', 'chrome', 'edge'])
  assert.equal(opts.find(o => o.value === 'chrome').disabled, false)
  assert.equal(opts.find(o => o.value === 'edge').disabled, false)
  assert.equal(opts.find(o => o.value === 'rbi').disabled, undefined)
})

test('buildEngineOptions disables chrome/edge when not entitled', () => {
  const opts = buildEngineOptions({ entitled: false })
  assert.equal(opts.find(o => o.value === 'chrome').disabled, true)
  assert.equal(opts.find(o => o.value === 'edge').disabled, true)
})

test('buildEngineOptions defaults to entitled (fail-open) with no args', () => {
  const opts = buildEngineOptions()
  assert.equal(opts.find(o => o.value === 'chrome').disabled, false)
})

test('PROFILE_NOTE warns about closing the browser and managed profile', () => {
  assert.match(PROFILE_NOTE, /close/i)
  assert.match(PROFILE_NOTE, /profile/i)
})
