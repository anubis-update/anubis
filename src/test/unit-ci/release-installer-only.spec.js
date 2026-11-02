const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

const root = path.resolve(__dirname, '../../..')
const workflow = file => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8'))

test('installer-only24 and25 tags cannot trigger multi-platform release or automatic deployment', () => {
  const release = workflow('release.yml')
  for (const tag of ['v5.7.24', 'v5.7.25']) {
    assert.ok(release.on.push.tags.includes('!' + tag))
    assert.ok(release.jobs['publish-self-hosted'].if.includes(`github.ref_name != '${tag}'`))
  }
  const guard = release.jobs.check.steps.find(step => step.name === 'Require Windows-only mode for installer-only releases')
  assert.ok(guard)
  assert.match(guard.run, /v5\.7\.24\|v5\.7\.25\)/)
  assert.match(guard.run, /WINDOWS_INSTALLER_ONLY" != "true"/)
  for (const name of ['win-portable', 'win-tar', 'linux-deb-tar', 'mac-x64', 'mac-arm']) {
    assert.match(release.jobs[name].if, /!\(github\.event_name == 'workflow_dispatch' && inputs\.windows_installer_only\)/)
  }
})

test('installer-only feed promotion requires explicit machine-host acceptance for24 and25', () => {
  const publish = workflow('publish-self-hosted.yml')
  const guard = publish.jobs.publish.steps.find(step => step.name === 'Validate restricted deployment configuration')
  assert.match(guard.run, /"\$TAG" == "v5\.7\.24" \|\| "\$TAG" == "v5\.7\.25"/)
  assert.match(guard.run, /WINDOWS_INSTALLER_ONLY" == "true" && "\$WINDOWS_MACHINE_HOST" == "true"/)
  const download = publish.jobs.publish.steps.find(step => step.name === 'Download and verify the existing release')
  assert.match(download.run, /sha256sum --check --strict SHA256SUMS/)
  assert.match(download.run, /--windows-installer-only/)
  assert.match(download.run, /release\.assets\.length, files\.length/)
})
