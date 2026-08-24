// Drive every branch — v2: use test-renderer's findAll with predicate on props.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { pluginPath, sdkStubPath, underTestPath, prepareHarnessDirs } from './helpers/paths.mjs'
import {
  chainOverview,
  chainTail,
  modelOptionsFixture,
  profileDescribeFixture,
} from './helpers/generic-fleet.mjs'

const overviewData = chainOverview()
const tailData = chainTail()
const modelOptions = modelOptionsFixture()
const profileDescribe = profileDescribeFixture()

const require = createRequire(import.meta.url)
const React = require('react')
const RTR = require('react-test-renderer')
const rtrAct = RTR.act

function restStub(path) {
  if (path.startsWith('/overview')) return Promise.resolve(overviewData)
  if (path.includes('/messages')) return Promise.resolve(tailData)
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
export const useQueryClient = () => ({ invalidateQueries: () => {} })
export const cn = (...a) => a.filter(Boolean).join(' ')
export const host = {
  request: method => Promise.resolve(method === 'plugins.manage'
    ? { plugins: [{ key: 'fleet-graph', status: 'enabled' }] }
    : method === 'model.options' ? { providers: [] }
    : method === 'profiles.describe' ? { skills: [], toolsets: [] }
    : { ok: true }),
  onEvent: () => () => {}, notify: () => {}
}
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
    // leaf (string label) — render directly, like the real ItemText
    return React.createElement('option', { 'data-slot': 'select-item', 'data-value': props.value, value: props.value }, String(ch))
  }
  const items = ch.filter(Boolean)
  return React.createElement('select', { 'data-slot': 'sdk-select', value: props.value, defaultValue: undefined },
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
mod.default.register({ rest: restStub, register: c => contributions.push(c), storage: { get: () => null, set: () => {} } })
const pg = contributions.find(c => c.area === 'routes' && c.data?.path === '/fleet-graph')

function textOf(inst) {
  const out = []
  function walk(n) {
    if (n == null) return
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.props && n.props.children !== undefined) walk(n.props.children)
  }
  walk(inst.toJSON ? inst : inst)
  // toJSON approach is simpler:
  return out.join('|')
}
function flatJson(node, out = []) {
  if (!node) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { node.forEach(n => flatJson(n, out)); return out }
  if (node.children) flatJson(node.children, out)
  return out
}

async function act(fn) {
  await rtrAct(async () => { await fn(); await new Promise(r => setTimeout(r, 120)) })
}

let renderer
await act(async () => {
  renderer = RTR.create(pg.render())
  await new Promise(r => setTimeout(r, 150))
})
const txt = flatJson(renderer.toJSON()).join('|')
console.log('tree mounted:', txt.slice(0, 70), '…')

// helper: find instance by rendered-text of its subtree
function findByText(rootInst, needle) {
  let hit = null
  rootInst.findAll(inst => {
    if (hit || typeof inst.type !== 'string' || !inst.props?.onClick) return false
    const s = flatJson(inst).join(' ')
    if (s.includes(needle)) { hit = inst; return true }
    return false
  }, { deep: true })
  return hit
}

// machine-enforced behavior gates: assertion failures drive the exit status.
let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`PASS ${name}`)
  } else {
    failed++
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// 1 → canvas
const graphBtn = findByText(renderer.root, 'Graph')
if (!graphBtn) { console.log('FAIL: Graph button not found'); process.exit(1) }
await act(async () => { graphBtn.props.onClick() })
const ctxt = flatJson(renderer.toJSON()).join('|')
check('canvas guidance visible', ctxt.includes('click a bot') && ctxt.includes('drag to pan'))
check('canvas SVG rendered', JSON.stringify(renderer.toJSON()).includes('"type":"svg"'))

// layout sanity: exercise the exported page's useLayout indirectly is not
// possible, so verify via rendered node transforms — no two nodes may share
// the same translate() origin.
{
  const seen = new Map()
  let dup = null
  renderer.root.findAll(inst => {
    if (inst.type !== 'g' || !inst.props?.transform) return false
    const t = inst.props.transform
    if (!t.startsWith('translate(')) return false
    if (seen.has(t) && t !== seen.get(t)) { /* same transform, different node */ }
    if (seen.has(t)) dup = t
    seen.set(t, inst)
    return false
  }, { deep: true })
  check('layout has no duplicate node origins', !dup, dup ? `DUPLICATE at ${dup}` : '')
}

// 2 → click first node g
let gHit = null
renderer.root.findAll(inst => {
  if (!gHit && inst.type === 'g' && inst.props?.onClick) { gHit = inst; return true }
  return false
}, { deep: true })
if (!gHit) { console.log('FAIL: no clickable node'); process.exit(1) }
await act(async () => { gHit.props.onClick() })
const dtxt = flatJson(renderer.toJSON()).join('|')
check('drawer opened', dtxt.includes('live · refreshes every 4s'))
check('tail messages rendered', dtxt.includes('hello') && dtxt.includes('hi there'))

// 3 → create dialog
const newBtn = findByText(renderer.root, 'New member')
if (!newBtn) { console.log('FAIL: New member button not found'); process.exit(1) }
await act(async () => { newBtn.props.onClick() })
const btxt = flatJson(renderer.toJSON()).join('|')
check('create dialog opened', btxt.includes('New fleet member'))
check('advanced toggle present', btxt.includes('Advanced'))

console.log('ALL BRANCHES DRIVEN')
console.log(`drive-harness summary: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
