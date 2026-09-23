// Build-time only: resolves the macOS SDK the native helpers compile against.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// `--sdk macosx` can select a newer SDK than the linker understands (#113708).
// Prefer the active toolchain's MacOSX.sdk alias unless the caller pins an SDK.
export function macosSysroot(env = process.env) {
  if (env.SDKROOT) {
    // SDKROOT accepts SDK names as well as paths; clang's -isysroot only accepts paths.
    return execFileSync('xcrun', ['--sdk', env.SDKROOT, '--show-sdk-path'], {
      encoding: 'utf8', env
    }).trim()
  }
  const developerDir = execFileSync('xcode-select', ['-p'], { encoding: 'utf8', env }).trim()
  return [
    resolve(developerDir, 'SDKs/MacOSX.sdk'),
    resolve(developerDir, 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'),
  ].find(existsSync) ?? null
}

// Preserve xcrun's previous selection when neither developer layout has a default.
// `--sdk` must precede the tool name or xcrun passes it to clang.
export function xcrunClangArgv(sysroot) {
  return sysroot ? ['clang', '-isysroot', sysroot] : ['--sdk', 'macosx', 'clang']
}
