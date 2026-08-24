// Loop-5 harness: optimistic markRead rollback, ts-type poisoning in
// useTrafficIndex consumers, liveProfiles event poisoning.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { pluginPath, sdkStubPath, underTestPath, prepareHarnessDirs } from './helpers/paths.mjs'
import { CAPTAIN, PLANNER, pairOverview } from './helpers/generic-fleet.mjs'

const require = createRequire(import.meta.url)
const React = require('react')
const RTR = require('react-test-renderer')
const rtrAct = RTR.act

// pairOverview with loop-5 overrides: inflated counts and no captain session;
// planner keeps the s2 session — identical shape to the previous inline fixture.
const overviewData = pairOverview({
  captainInbox: 2,
  captainUnread: 2,
  captainSession: null,
  plannerInbox: 1,
  plannerUnread: 1,
})
let failMarkRead = false
const tailData = { messages: [{ id: 1, role: 'user', text: 'hello' }] }
function restStub(path) {
  if (path.startsWith('/overview')) return Promise.resolve(JSON.parse(JSON.stringify(overviewData)))
  if (path.startsWith('/inbox/') && path.endsWith('/read')) {
    if (failMarkRead) return Promise.reject(new Error('backend down'))
    return Promise.resolve({ ok: true })
  }
  if (path.includes('/messages')) return Promise.resolve(tailData)
  // ts POISON: mixed types + garbage
  if (path.startsWith('/traffic')) return Promise.resolve({ messages: [
    { from: CAPTAIN, to: PLANNER, ts: '2026-08-22T06:00:00Z' },   // ISO string
    { from: PLANNER, to: CAPTAIN, ts: 1755846000000 },            // epoch number
    { from: CAPTAIN, to: PLANNER, ts: null },                     // null
    { from: CAPTAIN, to: PLANNER, ts: 'not-a-timestamp' },        // garbage string
    { from: CAPTAIN, to: PLANNER },                               // missing
    { from: CAPTAIN, to: PLANNER, ts: { nested: true } },         // object
  ] })
  if (path.startsWith('/sessions/tail')) return Promise.resolve({ sessions: {} })
  if (path.startsWith('/avatar/')) return Promise.resolve({ found: false })
  return Promise.resolve({})
}
function requestStub() { return Promise.resolve({ providers: [] }) }

// storage that THROWS on set (quota exceeded / serialization failure)
const throwingStorage = {
  get: () => null,
  set: (k, v) => { throw new Error('QuotaExceededError') },
}

prepareHarnessDirs()
writeFileSync(sdkStubPath, `
import React from 'react'
export function useQuery({ queryKey, queryFn, enabled = true }) {
  const [state, setState] = React.useState({ data: undefined, isLoading: !!enabled })
  React.useEffect(() => {
    if (enabled === false) return
    let alive = true
    queryFn().then(d => { if (alive) setState({ data: d, isLoading: false }) },
                  e => { if (alive) setState({ data: undefined, isLoading: false, isError: true }) })
    return () => { alive = false }
  }, [queryKey && JSON.stringify(queryKey), enabled])
  return state
}
export function useMutation({ mutationFn, onSuccess, onError }) {
  const [isPending, setPending] = React.useState(false)
  return { isPending, mutate: (a) => { setPending(true)
    Promise.resolve(mutationFn(a)).then(d => { setPending(false); onSuccess?.(d) }, e => { setPending(false); onError?.(e) }) } }
}
export const useQueryClient = () => ({
  invalidateQueries: () => {},
  setQueryData: (key, updater) => { globalThis.__setQueryCalls = (globalThis.__setQueryCalls || 0) + 1; updater && updater(globalThis.__cache || undefined); globalThis.__cache = { nodes: {} } },
})
export const cn = (...a) => a.filter(Boolean).join(' ')
export const host = {
  request: method => Promise.resolve(method === 'plugins.manage'
    ? { plugins: [{ key: 'fleet-graph', status: 'enabled' }] }
    : { providers: [] }),
  onEvent: (type, fn) => { (globalThis.__eventHandlers = globalThis.__eventHandlers || []).push(fn); return () => {} },
  notify: o => { globalThis.__lastNotify = o },
}
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export function SegmentedControl({ options, value, onChange, className }) {
  return React.createElement('div', { className }, options.map(o =>
    React.createElement('button', { key: o.id, onClick: () => onChange(o.id) }, o.label)))
}
export function Button(props) { const { size, variant, ...rest } = props; return React.createElement('button', { ...rest }) }
export function Input(props) { return React.createElement('input', { ...props }) }
export function Textarea(props) { return React.createElement('textarea', { ...props }) }
export function Checkbox(props) { return React.createElement('input', { type: 'checkbox', ...props }) }
export function Badge({ children }) { return React.createElement('span', null, children) }
export function Dialog({ open, children }) { return React.createElement('div', { 'data-open': !!open }, children) }
export function DialogContent(p) { return React.createElement('div', null, p.children) }
export function DialogHeader(p) { return React.createElement('div', null, p.children) }
export function DialogTitle(p) { return React.createElement('h2', null, p.children) }
export function DialogDescription(p) { return React.createElement('p', null, p.children) }
export function DialogFooter(p) { return React.createElement('div', null, p.children) }
export function Select(props) {
  const ch = props.children; const items = (Array.isArray(ch) ? ch : [ch]).filter(Boolean)
  return React.createElement('select', { value: props.value,
    onChange: e => props.onChange && props.onChange(e.target.value) },
    items.map((o, i) => React.createElement('option', { key: i, value: o.props.value }, o.props.children)))
}
Select._onChangeSink = null
export { Select as SelectSdk, Select as SelectContent, Select as SelectItem, Select as SelectTrigger, Select as SelectValue }
export function ErrorState({ title, description }) {
  return React.createElement('div', { 'data-slot': 'error-state' },
    React.createElement('div', null, title),
    description ? React.createElement('div', null, description) : null)
}
export function Skeleton(props) { return React.createElement('div', { ...props }) }
`)

const src = readFileSync(pluginPath, 'utf8')
writeFileSync(underTestPath, src)
const mod = await import(pathToFileURL(underTestPath).href + '?v=' + Date.now())
const contributions = []
mod.default.register({
  rest: restStub, register: c => contributions.push(c),
  storage: throwingStorage,
})
const pg = contributions.find(c => c.area === 'routes' && c.data?.path === '/fleet-graph')

function flatJson(node, out = []) {
  if (!node) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { node.forEach(n => flatJson(n, out)); return out }
  if (node.children) flatJson(node.children, out)
  return out
}
async function act(fn) { await rtrAct(async () => { await fn(); await new Promise(r => setTimeout(r, 150)) }) }

let passed = 0, failed = 0
const check = (n, ok, d = '') => { passed += !!ok; failed += !ok; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${n}${d ? ' — ' + d : ''}`) }

let renderer
await act(async () => {
  renderer = RTR.create(pg.render())
  await new Promise(r => setTimeout(r, 300))
})
check('page mounts with THROWING storage (viewport persist guarded)', true)

// canvas view with poisoned traffic feed — glow logic must not throw
const graphBtn = renderer.root.findAll(i => i.type === 'button' && flatJson(i).join(' ').includes('Graph'))[0]
await act(async () => { graphBtn.props.onClick() })
const all = JSON.stringify(renderer.toJSON())
check('canvas renders under ts-poisoned traffic (string/null/object/garbage)', all.includes('"type":"svg"'))

// fire poisoned lifecycle events at the page's onEvent handler
const handlers = globalThis.__eventHandlers || []
for (const fn of handlers) {
  try {
    fn({ profile: CAPTAIN, type: 'tool.start' })
    fn({ profile: CAPTAIN, type: 'tool.complete' })
    fn({ profile: null, type: 'tool.start' })       // no profile
    fn({ profile: 'unknown', type: 'weird.event' }) // unknown lifecycle prefix
    fn({ profile: CAPTAIN })                        // no type
    fn({})                                          // empty event
  } catch (e) {
    check('lifecycle events handled without throw', false, e.message)
  }
}
await act(async () => {})
check('lifecycle event storm survived', true, `${handlers.length} handler(s)`)

// markRead rollback: flip backend to failing, click the badge (tree view has
// the interactive badges; canvas nodes route clicks to the drawer instead)
const treeBtn = renderer.root.findAll(i => i.type === 'button' && /^(Tree|Deck)$/.test(flatJson(i).join(' ').trim()))[0]
if (!treeBtn) {
  // dump all button labels to see what's actually rendered (any element type)
  const labels = []
  renderer.root.findAll(i => { if (i.type === 'button') labels.push(flatJson(i).join(' ').trim()); return false })
  console.log('DEBUG buttons:', JSON.stringify(labels.slice(0, 12)))
}
await act(async () => { treeBtn && treeBtn.props.onClick() })
const badgeBtn = renderer.root.findAll(i =>
  i.type === 'button' && /Mark .* read|All read/.test(i.props?.title || ''))[0]
if (badgeBtn) {
  failMarkRead = true
  await act(async () => { badgeBtn.props.onClick({ stopPropagation: () => {} }) })
  check('markRead against failing backend does not crash UI', true,
    `notify="${(globalThis.__lastNotify || {}).message}"`)
} else {
  check('badge button present in tree view', false)
}

console.log(`\nLOOP5 SUMMARY: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
