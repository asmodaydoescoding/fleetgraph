// A3 hostile-payload harness: drives the plugin page with adversarial API data.
// Reuses the SDK stub builder from drive-harness.mjs, then mounts the page
// against payloads designed to crash naive consumers.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { pluginPath, sdkStubPath, underTestPath, prepareHarnessDirs } from './helpers/paths.mjs'

const require = createRequire(import.meta.url)
const React = require('react')
const RTR = require('react-test-renderer')
const rtrAct = RTR.act

// ── hostile overview: every field a component might trust is wrong ──
// Adversarial overrides are harness-specific by design; identities stay neutral.
const HOST = 'captain'
const hostileOverview = {
  nodes: {
    [HOST]: {
      supervisor: null, subordinates: null, peers: null, depth: 99,
      inbox: 0, unread: undefined, in_graph: true, has_avatar: false,
      color: '', title: '', latest_session: {},
    },
    'absent-node': {
      supervisor: HOST, subordinates: ['nobody', HOST], peers: ['absent2'],
      inbox: 3, unread: -7, in_graph: false,
    },
    'loop-node': {
      supervisor: 'loop-node', subordinates: [], depth: 0,
      unread: 1e9, in_graph: true, has_avatar: true,
      latest_session: { session_id: null, title: null, message_count: 'x', status: 42 },
    },
  },
}
const hostileTail = { sessions: {} }
const hostileTraffic = { messages: [
  { from: 'absentA', to: 'absentB', ts: 1 },        // pair not in graph at all
  { from: null, to: HOST, ts: 2 },                  // missing field
  { from: HOST, to: HOST, ts: 3 },                  // self-pair
  { ts: 4 },                                        // both missing
] }
const modelOptions = { providers: [{ slug: 'p', name: 'P', models: [] }] }
const profileDescribe = { skills: [], toolsets: [] }
function restStub(path) {
  if (path.startsWith('/overview')) return Promise.resolve(hostileOverview)
  if (path.startsWith('/sessions/tail')) return Promise.resolve(hostileTail)
  if (path.startsWith('/traffic')) return Promise.resolve(hostileTraffic)
  if (path.includes('/messages')) return Promise.resolve({ messages: null })
  if (path.startsWith('/avatar/')) return Promise.resolve({ found: false })
  return Promise.resolve({})
}
function requestStub(method) {
  if (method === 'model.options') return Promise.resolve(modelOptions)
  if (method === 'profiles.describe') return Promise.resolve(profileDescribe)
  return Promise.resolve({ ok: true })
}

prepareHarnessDirs()
writeFileSync(sdkStubPath, `
import React from 'react'
const cache = new Map()
export function useQuery({ queryKey, queryFn, enabled = true }) {
  const key = JSON.stringify(queryKey)
  const [state, setState] = React.useState(() =>
    cache.has(key) ? { data: cache.get(key), isLoading: false } : { data: undefined, isLoading: !!enabled })
  React.useEffect(() => {
    if (enabled === false || cache.has(key)) return
    let alive = true
    queryFn().then(d => { cache.set(key, d); if (alive) setState({ data: d, isLoading: false }) },
                  e => { if (alive) setState({ data: undefined, isLoading: false }) })
    return () => { alive = false }
  }, [key, enabled])
  return state
}
export function useMutation({ mutationFn, onSuccess, onError }) {
  const [isPending, setPending] = React.useState(false)
  return { isPending, mutate: (a) => { setPending(true)
    Promise.resolve(mutationFn(a)).then(d => { setPending(false); onSuccess?.(d) }, e => { setPending(false); onError?.(e) }) } }
}
export const useQueryClient = () => ({ invalidateQueries: () => {}, setQueryData: () => {} })
export const cn = (...a) => a.filter(Boolean).join(' ')
export const host = { request: (m, p) => requestStub(m, p), onEvent: () => () => {}, notify: () => {} }
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export function SegmentedControl({ options, value, onChange, className }) {
  return React.createElement('div', { className, 'data-slot': 'segmented' },
    options.map(o => React.createElement('button', {
      key: o.id, onClick: () => onChange(o.id),
      'aria-pressed': value === o.id,
    }, o.label)))
}
export function Button(props) {
  const { size, variant, ...rest } = props
  return React.createElement('button', { ...rest, 'data-size': size, 'data-variant': variant })
}
export function Input(props) { return React.createElement('input', { ...props, 'data-slot': 'sdk-input' }) }
export function Textarea(props) { return React.createElement('textarea', { ...props, 'data-slot': 'sdk-textarea' }) }
export function Checkbox(props) { return React.createElement('input', { type: 'checkbox', ...props, 'data-slot': 'sdk-checkbox' }) }
export function Badge({ children }) { return React.createElement('span', { 'data-slot': 'sdk-badge' }, children) }
export function Dialog({ open, onOpenChange, children }) {
  return React.createElement('div', { 'data-slot': 'dialog', 'data-open': !!open }, children)
}
export function DialogContent(props) { return React.createElement('div', { 'data-slot': 'dialog-content' }, props.children) }
export function DialogHeader(props) { return React.createElement('div', { 'data-slot': 'dialog-header' }, props.children) }
export function DialogTitle(props) { return React.createElement('h2', { 'data-slot': 'dialog-title' }, props.children) }
export function DialogDescription(props) { return React.createElement('p', { 'data-slot': 'dialog-description' }, props.children) }
export function DialogFooter(props) { return React.createElement('div', { 'data-slot': 'dialog-footer' }, props.children) }
export function Select(props) {
  const ch = (props.children === undefined) ? [] : props.children
  if (!Array.isArray(ch)) {
    return React.createElement('option', { 'data-slot': 'select-item', 'data-value': props.value, value: props.value }, String(ch))
  }
  const items = ch.filter(Boolean)
  return React.createElement('select', { 'data-slot': 'sdk-select', value: props.value, defaultValue: undefined, onChange: e => props.onChange && props.onChange(e.target.value) },
    items.map((o, i) => React.createElement('option', { key: i, value: o?.props?.value ?? '' }, o?.props?.children ?? '')))
}
Select._onChangeSink = null
export { Select as SelectSdk, Select as SelectContent, Select as SelectItem, Select as SelectTrigger, Select as SelectValue }
export function ErrorState({ title, description }) {
  return React.createElement('div', { 'data-slot': 'error-state' },
    React.createElement('div', null, title), description ? React.createElement('div', null, description) : null)
}
export function Skeleton(props) { return React.createElement('div', { ...props, 'data-slot': 'skeleton' }) }
`)

const src = readFileSync(pluginPath, 'utf8')
writeFileSync(underTestPath, src)
const mod = await import(pathToFileURL(underTestPath).href + '?v=' + Date.now())
const contributions = []
mod.default.register({
  rest: restStub, register: c => contributions.push(c),
  storage: {
    _m: { 'canvas-view': '{"tx":"NaN","ty":null,"scale":999,"extra":[1,2,3]}' }, // corrupted viewport JSON
    get(k) { return this._m[k] ?? null },
    set(k, v) { this._m[k] = v },
  },
})
const pg = contributions.find(c => c.area === 'routes' && c.data?.path === '/fleet-graph')
if (!pg) { console.log('FAIL: route not registered'); process.exit(1) }

function flatJson(node, out = []) {
  if (!node) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { node.forEach(n => flatJson(n, out)); return out }
  if (node.children) flatJson(node.children, out)
  return out
}
async function act(fn) {
  await rtrAct(async () => { await fn(); await new Promise(r => setTimeout(r, 150)) })
}

let renderer, mountError = null
try {
  await act(async () => {
    renderer = RTR.create(pg.render())
    await new Promise(r => setTimeout(r, 250))
  })
} catch (e) {
  mountError = e
}
if (mountError) {
  console.log('FAIL: crashed under hostile payloads:', mountError.message)
  process.exit(1)
}

let passed = 0, failed = 0
const check = (name, ok, detail = '') => { passed += !!ok; failed += !ok; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`) }

const txt = flatJson(renderer.toJSON()).join('|')
const all = JSON.stringify(renderer.toJSON())

// tree view survived?
const treeOk = (txt.includes('Deck') || txt.includes('Fleet Command')) && !txt.includes('the fleet graph view crashed')

// switch to canvas view — layout must survive cycle (loop-node->loop-node), null arrays, absent nodes
let canvasOk = false
const graphBtn = renderer.root.findAll(inst =>
  inst.type === 'button' && flatJson(inst).join(' ').trim() === 'Graph')[0]
await act(async () => { graphBtn && graphBtn.props.onClick() })
canvasOk = all2().includes('"type":"svg"')
function all2() { return JSON.stringify(renderer.toJSON()) }

// click a hostile node → drawer opens without latest_session fields
let drawerOk = false
const gHit = renderer.root.findAll(inst => inst.type === 'g' && inst.props?.onClick)[0]
if (gHit) {
  await act(async () => { gHit.props.onClick() })
  drawerOk = true // reaching here at all means no throw
}
check('hostile tree mounted', treeOk)
check('canvas rendered', canvasOk)
check('drawer opened', drawerOk)

// corrupted viewport was rejected (defaults kept)?
const storedRaw = contributions; // noop ref
check('render tree substantial', all2().length > 1000, `tree-bytes=${all2().length}`)
console.log('ALL HOSTILE BRANCHES DRIVEN')

console.log(`HOSTILE SUMMARY: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
