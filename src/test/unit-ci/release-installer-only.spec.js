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

test('draft CDN staging is explicit and cannot expose update metadata', () => {
  const publish = workflow('publish-self-hosted.yml')
  assert.equal(publish.on.workflow_dispatch.inputs.stage_only.default, false)
  const steps = publish.jobs.publish.steps
  const guard = steps.find(step => step.name === 'Validate restricted deployment configuration')
  assert.match(guard.run, /STAGE_ONLY" == "true"/)
  assert.match(guard.run, /Draft CDN staging requires explicit installer-only and machine-host inputs/)
  const download = steps.find(step => step.name === 'Download and verify the existing release')
  assert.match(download.run, /release\.draft, process\.env\.STAGE_ONLY === 'true'/)
  const upload = steps.find(step => step.name === 'Upload verified assets before exposing the update')
  assert.match(upload.run, /sha256sum --check --strict SHA256SUMS/)
  assert.doesNotMatch(upload.run, /publish-update|mirrored-release|version\.html/)
  const expose = steps.find(step => step.name === 'Expose verified update metadata')
  assert.match(expose.if, /^\$\{\{ inputs.stage_only != true \}\}$/)
  assert.match(expose.run, /publish-update\.js/)
  assert.ok(steps.indexOf(upload) < steps.indexOf(expose))
})
