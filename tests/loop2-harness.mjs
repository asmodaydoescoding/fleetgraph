// Loop-2 A3/B4-UI: create-dialog duplicate guard + drawer-vs-refetch + Escape.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { BUILDER, CAPTAIN, pairOverview } from './helpers/generic-fleet.mjs'
import { pluginPath, prepareHarnessDirs, sdkStubPath, underTestPath } from './helpers/paths.mjs'

const require = createRequire(import.meta.url)
const React = require('react')
const RTR = require('react-test-renderer')
const rtrAct = RTR.act

// Loop-2 defaults from the shared fixture builder (pairOverview).
const overviewData = pairOverview()
const tailData = { messages: [{ id: 1, role: 'user', text: 'hello' }] }
let overviewCalls = 0
function restStub(path) {
  if (path.startsWith('/overview')) { overviewCalls++; return Promise.resolve(overviewData) }
  if (path.includes('/messages')) return Promise.resolve(tailData)
  if (path.startsWith('/traffic')) return Promise.resolve({ messages: [] })
  if (path.startsWith('/avatar/')) return Promise.resolve({ found: false })
  if (path.startsWith('/sessions/tail')) return Promise.resolve({ sessions: {} })
  return Promise.resolve({})
}
function requestStub(method) {
  if (method === 'model.options') return Promise.resolve({ providers: [] })
  if (method === 'profiles.describe') return Promise.resolve({ skills: [], toolsets: [] })
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
                  e => { if (alive) setState({ data: undefined, isLoading: false, isError: true }) })
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
export const host = {
  request: (m, p) => requestStub(m, p), onEvent: () => () => {}, notify: o => globalThis.__lastNotify = o,
}
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export function SegmentedControl({ options, value, onChange, className }) {
  return React.createElement('div', { className }, options.map(o =>
    React.createElement('button', { key: o.id, onClick: () => onChange(o.id) }, o.label)))
}
export function Button(props) {
  const { size, variant, ...rest } = props
  return React.createElement('button', { ...rest, 'data-variant': variant })
}
export function Input(props) { return React.createElement('input', { ...props }) }
export function Textarea(props) { return React.createElement('textarea', { ...props }) }
export function Checkbox(props) { return React.createElement('input', { type: 'checkbox', ...props }) }
export function Badge({ children }) { return React.createElement('span', null, children) }
export function Dialog({ open, onOpenChange, children }) {
  return React.createElement('div', { 'data-open': !!open }, children)
}
export function DialogContent(p) { return React.createElement('div', null, p.children) }
export function DialogHeader(p) { return React.createElement('div', null, p.children) }
export function DialogTitle(p) { return React.createElement('h2', null, p.children) }
export function DialogDescription(p) { return React.createElement('p', null, p.children) }
export function DialogFooter(p) { return React.createElement('div', null, p.children) }
export function Select(props) {
  const ch = (props.children === undefined) ? [] : props.children
  const items = ((Array.isArray(ch)) ? ch : [ch]).filter(Boolean)
  return React.createElement('select', { value: props.value,
    onChange: e => props.onChange && props.onChange(e.target.value) },
    items.map((o, i) => React.createElement('option', { key: i, value: o?.props?.value ?? '' }, o?.props?.children ?? '')))
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
  storage: { get: () => null, set: () => {} },
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

let renderer
await act(async () => {
  renderer = RTR.create(pg.render())
  await new Promise(r => setTimeout(r, 250))
})

let passed = 0, failed = 0
const check = (n, ok, d = '') => { passed += !!ok; failed += !ok; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${n}${d ? ' — ' + d : ''}`) }

// open the create dialog (button label is "+ New member")
const newBtn = renderer.root.findAll(i => i.type === 'button' && flatJson(i).join(' ').includes('New member'))[0]
check('create dialog button found', !!newBtn)
await act(async () => { newBtn.props.onClick() })
let txt = () => flatJson(renderer.toJSON()).join('|')
check('dialog open', txt().includes('New fleet member'))

// type a DUPLICATE name ("captain" exists in the fixture graph)
const nameInput = renderer.root.findAll(i => i.type === 'input')[0]
await act(async () => { nameInput.props.onChange({ target: { value: CAPTAIN } }) })
txt = () => flatJson(renderer.toJSON()).join('|')
check('duplicate warning shown for existing name', txt().includes('already exists'))
const createBtns = renderer.root.findAll(i => i.type === 'button' && flatJson(i).join(' ').trim() === 'Create')
const cbtn = createBtns[0]
check('Create disabled while duplicate', cbtn && cbtn.props.disabled === true)

// rename to unique → warning clears, Create enables
await act(async () => { nameInput.props.onChange({ target: { value: BUILDER } }) })
check('warning cleared on unique name', !flatJson(renderer.toJSON()).join('|').includes('already exists'))
const cbtn2 = renderer.root.findAll(i => i.type === 'button' && flatJson(i).join(' ').trim() === 'Create')[0]
check('Create enabled for valid unique slug', cbtn2 && cbtn2.props.disabled === false)

console.log(`\nLOOP2 A3 SUMMARY: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
