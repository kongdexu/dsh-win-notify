// Smoke test: load the BUILT lib/index.js the way the DSH loader does and
// assert the exported plugin contract plus the shipped helper assets. No
// browser, no Windows API, no real subprocess. Runs after `npm run build`
// (see `check`), so lib/ reflects src/.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const libDir = path.join(root, '..', 'lib')
const libEntry = path.join(libDir, 'index.js')

let failures = 0
const assert = (cond, msg) => {
  if (cond) console.log('  ok  ' + msg)
  else { console.error('  FAIL ' + msg); failures += 1; }
};

(async () => {
  assert(existsSync(libEntry), 'lib/index.js exists (run npm run build first)')

  const mod = await import(pathToFileURL(libEntry).href)
  const plugin = mod.default ?? mod

  assert(plugin && plugin.name === 'dsh-win-notify', 'plugin name is dsh-win-notify')
  assert(Array.isArray(plugin.inject), 'inject is an array')
  assert(plugin.inject.includes('subprocess'), 'inject declares the "subprocess" service')
  assert(typeof plugin.apply === 'function', 'apply is a function')
  assert(typeof plugin.HELPER_DIR === 'string' && plugin.HELPER_DIR.length > 0, 'HELPER_DIR resolves the helper directory')

  // Shipped assets: the Windows toast helper must be inside the built tree so
  // the published package is self-contained.
  const helperDir = plugin.HELPER_DIR
  for (const f of ['DshToast.exe', 'DshToast.cs', 'notify.ico', 'whale-black-bg.png']) {
    assert(existsSync(path.join(helperDir, f)), `helper asset present: .dsh-notify/${f}`)
  }

  // Bind against a mock ctx: capture listener registrations and spawn calls.
  const listeners = []
  const spawns = []
  const ctx = {
    get: (svc) => (svc === 'sessionTitle' ? new Map() : undefined),
    on: (event, cb) => { listeners.push([event, cb]) },
    subprocess: {
      spawn: (opts) => { spawns.push(opts); return { done: Promise.resolve(0) } },
    },
  }
  plugin.apply(ctx)

  const events = listeners.map(([e]) => e)
  assert(events.includes('agent/status'), 'apply() registers agent/status')
  assert(events.includes('tools/execute'), 'apply() registers tools/execute')
  assert(events.includes('approval/request'), 'apply() registers approval/request')

  const isWin = process.platform === 'win32'
  if (isWin) {
    // Drive one root-agent completion through the registered listeners.
    const statusCb = listeners.find(([e]) => e === 'agent/status')?.[1]
    const agent = { session: { header: {} } }
    statusCb({ agent, status: 'running' })
    statusCb({ agent, status: 'idle' })
    const toast = spawns.find((s) => s.argv[0].toLowerCase().endsWith('dshtoast.exe'))
    assert(!!toast, 'root-agent running→idle spawns the helper EXE')
    assert(toast && toast.argv[1] === '任务完成', 'toast title is 任务完成')
    assert(toast && typeof toast.argv[2] === 'string' && toast.argv[2].length > 0, 'toast body is non-empty')
  } else {
    assert(listeners.length === 0, 'non-Windows host: apply() registers nothing (platform guard)')
  }

  // Byte-equality between the shipped helper source and the repo source is the
  // loader's concern; the .cs file merely needs to exist for the rebuild path.
  const cs = readFileSync(path.join(helperDir, 'DshToast.cs'), 'utf8')
  assert(cs.includes('ToastNotificationManager'), 'helper source references the WinRT toast API')

  console.log(failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((err) => { console.error(err); process.exit(1) })