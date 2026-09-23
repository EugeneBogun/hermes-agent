import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

import { macosSysroot } from './macos-sysroot.mjs'

test.skipIf(process.platform !== 'darwin')('builds both universal helpers with default, path and named SDK selection', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'hermes-sdk-builds-'))
  const env = { ...process.env, SDKROOT: '' }
  const helpers = [
    ['build-command-screenshot-monitor.mjs', 'native/command-screenshot-monitor'],
    ['build-hud-modifier-monitor.mjs', 'native/darwin-universal/hud-modifier-monitor']
  ]

  try {
    const sdk = macosSysroot(env) ?? execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
      encoding: 'utf8', env
    }).trim()
    const version = execFileSync('xcrun', ['--sdk', sdk, '--show-sdk-version'], {
      encoding: 'utf8', env
    }).trim()
    for (const [name, SDKROOT] of [['default', ''], ['path', sdk], ['name', `macosx${version}`]]) {
      for (const [script, relativeBinary] of helpers) {
        const dist = resolve(dir, name, script)
        execFileSync(process.execPath, [resolve(import.meta.dirname, script), '--out-dir', dist], {
          env: { ...env, SDKROOT }, timeout: 60_000
        })
        const architectures = execFileSync('xcrun', ['lipo', '-archs', resolve(dist, relativeBinary)], {
          encoding: 'utf8', env
        }).trim().split(/\s+/).sort()
        expect(architectures, `${script} with ${name} SDK selection`).toEqual(['arm64', 'x86_64'])
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 120_000)
