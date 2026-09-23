import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

const { execFileSync } = await import('node:child_process')
const { macosSysroot, xcrunClangArgv } = await import('./macos-sysroot.mjs')

afterEach(() => {
  vi.mocked(execFileSync).mockReset()
})

it('resolves explicit SDKs before developer defaults and preserves the no-SDK fallback', () => {
  const developerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysroot-'))
  const env = { DEVELOPER_DIR: developerDir }
  const sdk = path.join(developerDir, 'SDKs/MacOSX.sdk')

  try {
    for (const SDKROOT of [sdk, 'macosx']) {
      const override = { ...env, SDKROOT }
      vi.mocked(execFileSync).mockReturnValue(`${sdk}\n`)
      expect(macosSysroot(override)).toBe(sdk)
      expect(execFileSync).toHaveBeenLastCalledWith('xcrun', ['--sdk', SDKROOT, '--show-sdk-path'], {
        encoding: 'utf8', env: override
      })
    }

    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('SDK not found') })
    expect(() => macosSysroot({ ...env, SDKROOT: 'missing-sdk' })).toThrow('SDK not found')

    vi.mocked(execFileSync).mockReturnValue(`${developerDir}\n`)
    expect(macosSysroot(env)).toBeNull()
    expect(xcrunClangArgv(null)).toEqual(['--sdk', 'macosx', 'clang'])

    // When both layouts exist, the CLT default wins over the Xcode platform fallback.
    for (const relative of ['Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk', 'SDKs/MacOSX.sdk']) {
      const paired = path.join(developerDir, relative)
      fs.mkdirSync(paired, { recursive: true })
      expect(macosSysroot(env)).toBe(paired)
      expect(execFileSync).toHaveBeenLastCalledWith('xcode-select', ['-p'], { encoding: 'utf8', env })
      expect(xcrunClangArgv(paired)).toEqual(['clang', '-isysroot', paired])
    }
  } finally {
    fs.rmSync(developerDir, { recursive: true, force: true })
  }
})
