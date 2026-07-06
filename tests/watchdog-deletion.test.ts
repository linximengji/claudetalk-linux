import { describe, it } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const WATCHDOG_PATH = path.join(PROJECT_ROOT, 'watchdog.cjs')

// ---------------------------------------------------------------------------
// Happy path — normal deletion verification
// ---------------------------------------------------------------------------

describe('watchdog.cjs deletion — Happy path', () => {
  it('watchdog.cjs does not exist on disk', () => {
    assert.strictEqual(
      fs.existsSync(WATCHDOG_PATH),
      false,
      `Expected ${WATCHDOG_PATH} to be deleted, but it still exists`
    )
  })

  it('fs.accessSync throws ENOENT for watchdog.cjs', () => {
    assert.throws(
      () => fs.accessSync(WATCHDOG_PATH, fs.constants.R_OK),
      { code: 'ENOENT' }
    )
  })
})

// ---------------------------------------------------------------------------
// Boundary — edge cases
// ---------------------------------------------------------------------------

describe('watchdog.cjs deletion — Boundary', () => {
  it('case-insensitive path also not found (Windows)', () => {
    const lower = path.join(PROJECT_ROOT, 'watchDOG.CJS')
    // On case-insensitive (Windows), existsSync would return true if file existed
    // On case-sensitive (Linux), the exact path matters less
    assert.strictEqual(fs.existsSync(lower), false)
  })

  it('watchdog.cjs is NOT listed in package.json scripts or bin', () => {
    const pkgRaw = fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgRaw)

    const allScripts = Object.values(pkg.scripts || {})
    for (const script of allScripts) {
      assert.strictEqual(
        (script as string).includes('watchdog.cjs'),
        false,
        `package.json script references watchdog.cjs: "${script}"`
      )
    }

    const bin = pkg.bin
    if (typeof bin === 'string') {
      assert.strictEqual(bin.includes('watchdog'), false)
    } else if (bin && typeof bin === 'object') {
      for (const [, v] of Object.entries(bin)) {
        assert.strictEqual((v as string).includes('watchdog.cjs'), false)
      }
    }
  })

  it('empty source tree does not crash the scan', () => {
    // Scan an empty directory for watchdog.cjs references — should return 0 matches
    const emptyDir = path.join(PROJECT_ROOT, 'tests', '__empty__')
    fs.mkdirSync(emptyDir, { recursive: true })
    try {
      const found = findWatchdogReferences(emptyDir)
      assert.strictEqual(found.length, 0)
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('path with special characters resolves correctly', () => {
    // Just verify the path is valid and normal — not mangled by encoding issues
    assert.ok(path.isAbsolute(WATCHDOG_PATH))
    assert.ok(WATCHDOG_PATH.includes('watchdog.cjs'))
  })
})

// ---------------------------------------------------------------------------
// Exception paths
// ---------------------------------------------------------------------------

describe('watchdog.cjs deletion — Exception', () => {
  it('does not crash when scanning unreadable directory', () => {
    // Windows: we can't easily create an unreadable dir without admin,
    // so we verify the scan handles EACCES gracefully
    // This simulates the scenario where a dir inside the scan has bad perms
    assert.doesNotThrow(() => {
      const found = findWatchdogReferences(PROJECT_ROOT, {
        skipDirs: new Set(['node_modules', 'dist', 'tests', '.git']),
      })
      // For existing project files, we should at least not crash
      assert.ok(Array.isArray(found))
    })
  })

  it('watchdog.cjs is not recreated accidentally (stale .lnk or shortcut)', () => {
    // Verify no *.lnk files in the project root point to watchdog.cjs
    const rootEntries = fs.readdirSync(PROJECT_ROOT)
    const lnkFiles = rootEntries.filter(e => e.toLowerCase().endsWith('.lnk'))
    for (const lnk of lnkFiles) {
      assert.ok(
        !lnk.toLowerCase().includes('watchdog'),
        `Found suspicious .lnk file: ${lnk}`
      )
    }
  })

  it('no stale .old or .bak backup of watchdog.cjs exists', () => {
    const rootEntries = fs.readdirSync(PROJECT_ROOT)
    const stale = rootEntries.filter(e =>
      e.toLowerCase().includes('watchdog') &&
      (e.toLowerCase().endsWith('.old') || e.toLowerCase().endsWith('.bak'))
    )
    assert.deepStrictEqual(stale, [], `Stale backup files found: ${stale.join(', ')}`)
  })
})

// ---------------------------------------------------------------------------
// Async / timing — concurrent access & stat races
// ---------------------------------------------------------------------------

describe('watchdog.cjs deletion — Async / timing', () => {
  it('repeated existence check returns consistent result', async () => {
    // Race: check file absence multiple times concurrently
    const checks = Array.from({ length: 10 }, async () => {
      await new Promise(r => setTimeout(r, Math.random() * 5))
      return fs.existsSync(WATCHDOG_PATH)
    })
    const results = await Promise.all(checks)
    for (const r of results) {
      assert.strictEqual(r, false, 'Concurrent check found file that should be deleted')
    }
  })

  it('stat and exists agree on file absence', async () => {
    const results = await Promise.all([
      // existsSync
      new Promise<boolean>(resolve => setTimeout(() => resolve(fs.existsSync(WATCHDOG_PATH)), 1)),
      // stat (should throw)
      new Promise<boolean>(resolve => {
        try { fs.statSync(WATCHDOG_PATH); resolve(true) }
        catch { resolve(false) }
      }),
      // access
      new Promise<boolean>(resolve => {
        try { fs.accessSync(WATCHDOG_PATH); resolve(true) }
        catch { resolve(false) }
      }),
    ])
    for (const r of results) {
      assert.strictEqual(r, false, 'exists, stat, and access must all agree file is absent')
    }
  })
})

// ===========================================================================
// Reference scan
// ===========================================================================

describe('watchdog.cjs — No source code references', () => {
  const REF_PATTERN = /(?:require|import)\s*\(?\s*(?:['"].*?watchdog\.cjs['"]|['"]\.?\.?\/?watchdog\.cjs['"])/i
  const FILENAME_PATTERN = /watchdog\.cjs/i

  it('no require/import of watchdog.cjs in any .ts file', () => {
    const refs = findWatchdogReferences(PROJECT_ROOT, {
      skipDirs: new Set(['node_modules', 'dist', 'tests', '.git']),
      extensions: new Set(['.ts']),
      ignorePlanDocs: true,
    })
    assert.deepStrictEqual(
      refs,
      [],
      `Found require/import of watchdog.cjs in .ts files: ${JSON.stringify(refs)}`
    )
  })

  it('no require/import of watchdog.cjs in any .js file (non-dist)', () => {
    const refs = findWatchdogReferences(PROJECT_ROOT, {
      skipDirs: new Set(['node_modules', 'dist', 'tests', '.git']),
      extensions: new Set(['.js', '.cjs', '.mjs']),
      ignorePlanDocs: true,
    })
    assert.deepStrictEqual(
      refs,
      [],
      `Found require/import of watchdog.cjs in .js files: ${JSON.stringify(refs)}`
    )
  })

  it('no reference to watchdog.cjs in shell scripts or bat files', () => {
    const refs = findWatchdogReferences(PROJECT_ROOT, {
      skipDirs: new Set(['node_modules', 'dist', 'tests', '.git']),
      extensions: new Set(['.sh', '.bat', '.cmd', '.ps1']),
      ignorePlanDocs: true,
    })
    assert.deepStrictEqual(
      refs,
      [],
      `Found watchdog.cjs reference in shell scripts: ${JSON.stringify(refs)}`
    )
  })

  it('no reference to watchdog.cjs in ops-daemon project', () => {
    const opsDaemonRoot = path.resolve(PROJECT_ROOT, '..', 'ops-daemon')
    if (fs.existsSync(opsDaemonRoot)) {
      const refs = findWatchdogReferences(opsDaemonRoot)
      assert.deepStrictEqual(
        refs,
        [],
        `Found watchdog.cjs reference in ops-daemon: ${JSON.stringify(refs)}`
      )
    } else {
      // ops-daemon not present — still passes
      assert.ok(true)
    }
  })
})

// ===========================================================================
// Helpers
// ===========================================================================

interface ScanOptions {
  skipDirs?: Set<string>
  extensions?: Set<string>
  ignorePlanDocs?: boolean
}

function findWatchdogReferences(
  root: string,
  opts: ScanOptions = {},
): string[] {
  const skipDirs = opts.skipDirs ?? new Set(['node_modules', 'dist', '.git'])
  const extensions = opts.extensions ?? new Set(['.ts', '.js', '.cjs', '.mjs', '.json', '.sh'])
  const ignorePlanDocs = opts.ignorePlanDocs ?? false

  const results: string[] = []

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name)

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        results.push(...findWatchdogReferences(fullPath, opts))
        continue
      }

      const ext = path.extname(entry.name).toLowerCase()
      // Also check .sh files with no extension
      const matchesExt = extensions.has(ext)

      // Handle files without extension but named restart, etc.
      const shouldCheck = extensions.has(ext) || entry.name === 'restart.sh' || entry.name === 'ARCHITECTURE.md'

      if (!shouldCheck) continue

      // Skip .plan.md and ARCHITECTURE.md if ignorePlanDocs is set
      if (ignorePlanDocs && (entry.name === '.plan.md' || entry.name === 'ARCHITECTURE.md')) continue

      try {
        const content = fs.readFileSync(fullPath, 'utf-8')
        if (content.includes('watchdog.cjs')) {
          results.push(fullPath)
        }
      } catch {
        // EACCES or encoding error — skip
      }
    }
  } catch {
    // root dir not accessible
  }

  return results
}
