/**
 * verify-client.mjs — reproduce the loader's registration contract without a
 * browser: evaluate lib/client.js in a VM with a window.__ModuleLoader__ stub,
 * then assert the module registered under the package id and its factory
 * returns { name, inject, apply }.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const code = readFileSync(join(root, 'lib/client.js'), 'utf8')

if (!code.startsWith('window.__ModuleLoader__.load({')) {
  console.error('[verify-client] FAIL: missing ModuleLoader.load registration prefix')
  process.exit(1)
}

let registered = null
const stubs = {
  react: {
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
  },
  'react-dom/client': { createRoot: () => ({ render: () => {} }) },
}
const requireStub = (specifier) => {
  if (!(specifier in stubs)) throw new Error(`unexpected require: ${specifier}`)
  return stubs[specifier]
}

const window = {
  __ModuleLoader__: {
    load(entry) {
      registered = entry
    },
  },
}

const sandbox = { window, require: requireStub }
vm.createContext(sandbox)
try {
  vm.runInContext(code, sandbox, { filename: 'lib/client.js' })
} catch (error) {
  console.error('[verify-client] FAIL: evaluating client.js threw:', error)
  process.exit(1)
}

if (!registered) {
  console.error('[verify-client] FAIL: load() was never called')
  process.exit(1)
}
if (registered.id !== PKG.name) {
  console.error(`[verify-client] FAIL: registered id ${registered.id} !== ${PKG.name}`)
  process.exit(1)
}

let mod
try {
  mod = registered.factory(requireStub)
} catch (error) {
  console.error('[verify-client] FAIL: factory threw:', error)
  process.exit(1)
}

const name = mod?.name ?? mod?.default?.name
const inject = mod?.inject ?? mod?.default?.inject
const apply = mod?.apply ?? mod?.default?.apply
if (typeof name !== 'string' || name !== PKG.name) {
  console.error('[verify-client] FAIL: module name mismatch:', name)
  process.exit(1)
}
if (!Array.isArray(inject)) {
  console.error('[verify-client] FAIL: inject is not an array')
  process.exit(1)
}
if (typeof apply !== 'function') {
  console.error('[verify-client] FAIL: apply is not a function')
  process.exit(1)
}
console.log(`[verify-client] OK id=${registered.id} name=${name} inject=[${inject.join(',')}] apply=fn`)
