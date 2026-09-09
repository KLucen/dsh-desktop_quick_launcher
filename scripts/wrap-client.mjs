/**
 * wrap-client.mjs — build the browser half as a DSH classic-script bundle.
 *
 * DSH's client loader (ModuleLoader) requires each plugin's `./client` entry
 * to be a classic script that self-registers:
 *
 *   window.__ModuleLoader__.load({
 *     id: "<package name>",
 *     factory: (require) => { ...; return module.exports; }
 *   })
 *
 * The loader provides `require`; react / react-dom are resolved from the
 * shared browser bundle, so they stay external here. Plain ESM output (like
 * tsdown's client.mjs) breaks the loader — see the crash
 * "...loaded without registering dsh-desktop_quick_launcher via
 * ModuleLoader.load".
 *
 * Run after `tsdown` (which emits lib/client.mjs + d.ts; the unused .mjs is
 * removed here). Output: lib/client.js (classic script, UTF-8).
 */
import { build } from 'esbuild'
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const MODULE_ID = PKG.name

const banner = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(MODULE_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
`

const footer = `
		return module.exports;
	}
});
`

const result = await build({
  entryPoints: [join(root, 'src/client.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  charset: 'utf8',
  external: ['react', 'react-dom', 'react-dom/client'],
})

const body = result.outputFiles[0].text
const wrapped = banner + body + footer
writeFileSync(join(root, 'lib/client.js'), wrapped, 'utf8')

// tsdown also emits an unused ESM client.mjs — remove it so only the
// loadable classic script ships.
try { rmSync(join(root, 'lib/client.mjs')) } catch { /* ignore */ }

console.log(`[wrap-client] lib/client.js written (${wrapped.length} bytes, id=${MODULE_ID})`)
