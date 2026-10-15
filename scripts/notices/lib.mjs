/**
 * Third-party licence notices: what ships, under which licence, with its text.
 *
 * Pure functions over a lockfile, a node_modules tree and a few hand-kept
 * lists, so the rules can be tested without a build. The driver is
 * scripts/build-notices.mjs.
 *
 * An ALLOWLIST, not a scan for known-bad licences, for the same reason
 * electron-builder.yml names its files positively: a denylist cannot report
 * what is not on it. A licence the list does not name fails the build until
 * someone reads it and decides.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Licences the app may ship. Each is permissive or file-level copyleft (MPL, EPL). */
export const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'MPL-2.0',
  'EPL-1.0',
  'EPL-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'Zlib',
])

/**
 * The licence a package.json declares, as one SPDX expression.
 *
 * Old packages write `{ "type": "MIT", "url": … }` or a `licenses` array of
 * those instead of an SPDX string; an array offers its entries as
 * alternatives.
 */
export function declaredLicense(pkg) {
  const one = (l) => (typeof l === 'string' ? l : l && typeof l.type === 'string' ? l.type : null)
  if (pkg.license !== undefined) {
    if (Array.isArray(pkg.license)) return pkg.license.map(one).filter(Boolean).join(' OR ') || null
    return one(pkg.license)
  }
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map(one).filter(Boolean).join(' OR ') || null
  return one(pkg.licenses)
}

function tokens(expr) {
  return expr.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/).filter(Boolean)
}

/**
 * Whether an SPDX expression permits shipping under `allowed`.
 *
 * `A OR B` needs one side allowed (the app takes that licence: jszip's
 * `MIT OR GPL-3.0-or-later` ships as MIT); `A AND B` needs both (pako's
 * `MIT AND Zlib`). `A WITH exception` is judged as A: an exception only adds
 * permissions. Anything malformed is not allowed.
 */
export function isAllowed(expr, allowed = ALLOWED) {
  if (!expr) return false
  const t = tokens(expr)
  let i = 0
  const factor = () => {
    if (t[i] === '(') {
      i++
      const v = or()
      if (t[i++] !== ')') throw new Error('unbalanced')
      return v
    }
    const id = t[i++]
    if (!id || /^(AND|OR|WITH|\))$/.test(id)) throw new Error('expected a licence')
    if (t[i] === 'WITH') i += 2
    return allowed.has(id.replace(/\+$/, ''))
  }
  const and = () => {
    let v = factor()
    while (t[i] === 'AND') {
      i++
      v = factor() && v
    }
    return v
  }
  const or = () => {
    let v = and()
    while (t[i] === 'OR') {
      i++
      v = and() || v
    }
    return v
  }
  try {
    const v = or()
    return i === t.length && v
  } catch {
    return false
  }
}

/** The licence ids an expression names, for choosing a standard text. */
export function licenseIds(expr) {
  return tokens(expr ?? '').filter((x) => !/^(AND|OR|WITH|\(|\))$/.test(x))
}

/** The licence files a package directory ships, in a stable order. */
export function licenseTexts(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => /^(un)?licen[cs]e|^copying|^notice/i.test(f))
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() }))
}

/** "Name <mail> (url)" or { name } → "Name"; falls back to the package's authors. */
export function holderOf(pkg) {
  const raw = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  const name = raw?.replace(/<[^>]*>|\([^)]*\)/g, '').trim()
  return name || `the ${pkg.name} authors`
}

/**
 * Every shipped component with the text of its licence.
 *
 * Sources:
 *   - the lockfile's non-dev packages that are installed (what electron-builder
 *     packs from node_modules);
 *   - `bundled`: packages the bundler inlined (devDependencies such as React);
 *   - `vendored`: things with no package at all, or copied in another way.
 *
 * A package that ships no licence file gets the standard text of its declared
 * licence with its author as the holder, and says so. Errors are collected,
 * not thrown, so one run reports every problem.
 */
export function collectNotices({ root, lock, bundled = [], vendored = [], overrides = {}, templates = {}, allowed = ALLOWED }) {
  const errors = []
  const byId = new Map()
  const usedOverrides = new Set()

  const add = (dir, from) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const id = `${pkg.name}@${pkg.version}`
    const existing = byId.get(id)
    if (existing) {
      if (!existing.from.includes(from)) existing.from.push(from)
      return
    }
    const override = overrides[pkg.name]
    if (override) usedOverrides.add(pkg.name)
    const license = override?.license ?? declaredLicense(pkg)
    const entry = { name: pkg.name, version: pkg.version, license: license ?? 'UNKNOWN', from: [from], texts: licenseTexts(dir) }
    if (override?.note) entry.note = override.note
    if (!isAllowed(license, allowed)) {
      errors.push(`${id}: licence ${JSON.stringify(license ?? null)} is not on the allowlist (scripts/notices/lib.mjs ALLOWED)`)
    }
    if (entry.texts.length === 0) {
      const template = licenseIds(license).map((l) => templates[l]).find(Boolean)
      if (template) {
        entry.texts = [{ file: `${licenseIds(license).find((l) => templates[l])} (standard text)`, text: template.replace('{{holder}}', holderOf(pkg)).trim() }]
        entry.note = entry.note ?? 'The package ships no licence file; this is the standard text of the licence it declares.'
      } else {
        errors.push(`${id}: ships no licence text, and there is no standard text for ${JSON.stringify(license)}`)
      }
    }
    byId.set(id, entry)
  }

  for (const [key, info] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/') || info.dev) continue
    const dir = join(root, key)
    if (!existsSync(join(dir, 'package.json'))) continue // an optional package for another platform
    add(dir, 'node_modules')
  }
  for (const b of bundled) {
    if (!existsSync(join(b.dir, 'package.json'))) {
      errors.push(`${b.id}: recorded as bundled, but ${b.dir} has no package.json (rebuild with electron-vite)`)
      continue
    }
    add(b.dir, 'bundled')
  }
  for (const v of vendored) {
    let version = v.version
    let texts = []
    if (v.package) {
      const dir = join(root, 'node_modules', v.package)
      if (!existsSync(join(dir, 'package.json'))) {
        errors.push(`${v.name}: vendored from ${v.package}, which is not installed`)
        continue
      }
      version = version ?? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
      texts = licenseTexts(dir)
    }
    if (v.licenseFrom) {
      const file = join(root, v.licenseFrom)
      if (!existsSync(file)) errors.push(`${v.name}: licence text ${v.licenseFrom} is missing`)
      else texts = [{ file: v.licenseFrom.split('/').pop(), text: readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim() }]
    }
    if (!isAllowed(v.license, allowed)) errors.push(`${v.name}: licence ${JSON.stringify(v.license)} is not on the allowlist`)
    if (texts.length === 0) errors.push(`${v.name}: no licence text`)
    byId.set(`${v.name}@${version}`, { name: v.name, version, license: v.license, from: ['vendored'], texts, note: v.note })
  }
  for (const name of Object.keys(overrides)) {
    if (!usedOverrides.has(name)) errors.push(`override for ${name} matches no shipped package; remove it`)
  }

  const entries = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  return { entries, errors }
}

/** The plain-text file that ships beside the app. */
export function noticesText(app, entries) {
  const rule = '-'.repeat(78)
  const parts = [
    `${app.name} ${app.version}`,
    '',
    app.license,
    '',
    rule,
    `Third-party software (${entries.length} components)`,
    rule,
  ]
  for (const e of entries) {
    parts.push('', `${e.name} ${e.version}`, `Licence: ${e.license}`)
    if (e.note) parts.push(`Note: ${e.note}`)
    for (const t of e.texts) parts.push('', t.text)
    parts.push('', rule)
  }
  return parts.join('\n') + '\n'
}
