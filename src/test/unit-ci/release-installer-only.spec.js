const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '../../..')
const workflow = file => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8'))

test('installer-only24,25 and26 tags cannot trigger multi-platform release or automatic deployment', () => {
  const release = workflow('release.yml')
  for (const tag of ['v5.7.24', 'v5.7.25', 'v5.7.26']) {
    assert.ok(release.on.push.tags.includes('!' + tag))
    assert.ok(release.jobs['publish-self-hosted'].if.includes(`github.ref_name != '${tag}'`))
  }
  const guard = release.jobs.check.steps.find(step => step.name === 'Require Windows-only mode for installer-only releases')
  assert.ok(guard)
  assert.match(guard.run, /v5\.7\.24\|v5\.7\.25\|v5\.7\.26\)/)
  assert.match(guard.run, /WINDOWS_INSTALLER_ONLY" != "true"/)
  for (const name of ['win-portable', 'win-tar', 'linux-deb-tar', 'mac-x64', 'mac-arm']) {
    assert.match(release.jobs[name].if, /!\(github\.event_name == 'workflow_dispatch' && inputs\.windows_installer_only\)/)
  }
})

test('installer-only feed promotion requires explicit machine-host acceptance for24,25 and26', () => {
  const publish = workflow('publish-self-hosted.yml')
  const guard = publish.jobs.publish.steps.find(step => step.name === 'Validate restricted deployment configuration')
  assert.match(guard.run, /"\$TAG" == "v5\.7\.24" \|\| "\$TAG" == "v5\.7\.25" \|\| "\$TAG" == "v5\.7\.26"/)
  assert.match(guard.run, /WINDOWS_INSTALLER_ONLY" == "true" && "\$WINDOWS_MACHINE_HOST" == "true"/)
  const download = publish.jobs.publish.steps.find(step => step.name === 'Download and verify the existing release')
  assert.match(download.run, /sha256sum --check --strict SHA256SUMS/)
  assert.match(download.run, /--windows-installer-only/)
  assert.match(download.run, /release\.assets\.length, files\.length/)
})

test('actual publication shell guard rejects unaccepted modes and unlisted versions without deployment', () => {
  const shell = process.env.ANUBIS_TEST_BASH || (process.platform === 'win32'
    ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
    : 'bash')
  const publish = workflow('publish-self-hosted.yml')
  const script = publish.jobs.publish.steps.find(step => step.name === 'Validate restricted deployment configuration').run
  const boundary = script.indexOf('for name in DEPLOY_HOST ')
  assert(boundary > 0)
  const guard = script.slice(0, boundary)
  const run = (tag, installer, machine, stage) => spawnSync(shell, ['--noprofile', '--norc', '-c', guard], {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      TAG: tag,
      WINDOWS_INSTALLER_ONLY: String(installer),
      WINDOWS_MACHINE_HOST: String(machine),
      STAGE_ONLY: String(stage)
    }
  })
  for (const tag of ['v5.7.24', 'v5.7.25', 'v5.7.26']) {
    for (const stage of [false, true]) {
      const accepted = run(tag, true, true, stage)
      assert.equal(accepted.status, 0, accepted.error?.message || accepted.stderr)
      for (const [installer, machine] of [[false, true], [true, false], [false, false]]) {
        assert.notEqual(run(tag, installer, machine, stage).status, 0)
      }
    }
  }
  for (const tag of ['v5.7.27', 'v5.8.0']) {
    assert.equal(run(tag, false, false, false).status, 0)
    assert.notEqual(run(tag, true, true, false).status, 0)
    assert.notEqual(run(tag, true, true, true).status, 0)
    assert.notEqual(run(tag, false, true, true).status, 0)
  }
  assert.notEqual(run('v5.7.26-rc.1', true, true, true).status, 0)
})

test('draft CDN staging is explicit and cannot expose update metadata', () => {
  const publish = workflow('publish-self-hosted.yml')
  assert.equal(publish.on.workflow_dispatch.inputs.stage_only.default, false)
  assert.equal(publish.jobs.publish.permissions.contents, 'write')
  const steps = publish.jobs.publish.steps
  const guard = steps.find(step => step.name === 'Validate restricted deployment configuration')
  assert.match(guard.run, /STAGE_ONLY" == "true"/)
  assert.match(guard.run, /Draft CDN staging requires explicit installer-only and machine-host inputs/)
  const download = steps.find(step => step.name === 'Download and verify the existing release')
  assert.match(download.run, /release\.draft, process\.env\.STAGE_ONLY === 'true'/)
  assert.match(download.run, /--json databaseId --jq '\.databaseId'/)
  assert.match(download.run, /releases\/\$release_id/)
  assert.doesNotMatch(download.run, /releases\/tags\//)
  const upload = steps.find(step => step.name === 'Upload verified assets before exposing the update')
  assert.match(upload.run, /sha256sum --check --strict SHA256SUMS/)
  assert.doesNotMatch(upload.run, /publish-update|mirrored-release|version\.html/)
  const expose = steps.find(step => step.name === 'Expose verified update metadata')
  assert.match(expose.if, /^\$\{\{ inputs.stage_only != true \}\}$/)
  assert.match(expose.run, /publish-update\.js/)
  assert.ok(steps.indexOf(upload) < steps.indexOf(expose))
})
