// Loop-6 (tree redesign) harness: verifies the new Tree UX end to end.
// Paths come from the shared portable helper, so any checkout runs this
// harness unmodified. Fixtures are the shared neutral deck fixtures:
// captain (live bot) -> planner (age-stamped ready session) plus the
// out-of-graph unassigned profile exercised by the attach checks.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { pluginPath, sdkStubPath, underTestPath, prepareHarnessDirs } from './helpers/paths.mjs'
import { deckOverview, deckRoster, chainTail } from './helpers/generic-fleet.mjs'
const require = createRequire(import.meta.url)
const React = require('react')
const RTR = require('react-test-renderer')
const rtrAct = RTR.act

// Same shape as the previous inline fixture: captain session active 30s ago,
// planner session ~1d old ("ready 1d"), and the in-graph:false unassigned row.
const overviewData = deckOverview()
const tailData = chainTail()
const rosterData = deckRoster()
function restStub(path) {
  if (path.startsWith('/overview')) return Promise.resolve(overviewData)
  if (path.startsWith('/roster')) return Promise.resolve(rosterData)
  if (path.startsWith('/traffic')) return Promise.resolve({ messages: [] })
  if (path.includes('/messages')) return Promise.resolve(tailData)
  if (path.startsWith('/inbox/')) return Promise.resolve({ messages: [{ from: 'x', type: 'update', summary: 'note' }] })
  if (path.startsWith('/avatar/')) return Promise.resolve({ found: false })
  if (path.startsWith('/sessions/tail')) return Promise.resolve({ sessions: {} })
  return Promise.resolve({})
}
function requestStub() { return Promise.resolve({ providers: [] }) }
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
  }, [JSON.stringify(queryKey), enabled])
  return state
}
export function useMutation({ mutationFn, onSuccess, onError }) {
  const [isPending, setPending] = React.useState(false)
  return { isPending, mutate: a => { setPending(true);
    Promise.resolve(mutationFn(a)).then(d => { setPending(false); onSuccess?.(d) }, e => { setPending(false); onError?.(e) }) } }
}
export const useQueryClient = () => ({ invalidateQueries: () => {}, setQueryData: () => {} })
export const cn = (...a) => a.filter(Boolean).join(' ')
export const host = { request: () => requestStub(), onEvent: () => () => {}, notify: () => {} }
export const ROUTES_AREA = 'routes'; export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export function SegmentedControl({ options, value, onChange, className }) {
  return React.createElement('div', { className }, options.map(o =>
    React.createElement('button', { key: o.id, onClick: () => onChange(o.id) }, o.label)))
}
export function Button(props) { const { size, variant, ...rest } = props; return React.createElement('button', { ...rest }) }
export function Input(props) { return React.createElement('input', { ...props }) }
export function Textarea(props) { return React.createElement('textarea', { ...props }) }
export function Checkbox(props) { return React.createElement('input', { type: 'checkbox', ...props }) }
export function Badge({ children }) { return React.createElement('span', null, children) }
export function Dialog({ open, children }) { return React.createElement('div', null, children) }
export function DialogContent(p) { return React.createElement('div', null, p.children) }
export function DialogHeader(p) { return React.createElement('div', null, p.children) }
export function DialogTitle(p) { return React.createElement('h2', null, p.children) }
export function DialogDescription(p) { return React.createElement('p', null, p.children) }
export function DialogFooter(p) { return React.createElement('div', null, p.children) }
let __lastSelectItems = []
export function __lastItems(){ return __lastSelectItems }
export function Select(props) {
  try {
    const ch = (props.children === undefined) ? [] : props.children
    if (!Array.isArray(ch)) {
      // leaf (string label) — render directly, like the real ItemText
      return React.createElement('div', { 'data-slot': 'select-item', 'data-value': props.value }, String(ch))
    }
    const items = ch.filter(Boolean)
  if (items.some(o => !o || typeof o !== 'object' || o.props === undefined)) {
    console.error('STUB-SELECT bad item detected; children=', JSON.stringify(props.children)?.slice(0, 300))
    throw new Error('stub-select bad item')
  }
  // Radix-faithful: item text comes ONLY from Item children; if the plugin passes no
  // children to SelectItem the row renders EMPTY — exactly the bug class we're testing.
  __lastSelectItems = items.map(o => ({ value: o?.props?.value, label: o?.props?.children ?? null })).filter(x => x.value !== undefined)
  return React.createElement('div', { 'data-select-stub': true },
    items.map((o, i) => React.createElement('div', { key: i, 'data-item-label': o?.props?.children ?? '' },
      React.createElement('span', null, o?.props?.children ?? ''))))
  } catch (e) { console.error('STUB-SELECT THROW:', e.message); throw e }
}
Select._onChangeSink = null
export { Select as SelectSdk, Select as SelectContent, Select as SelectItem, Select as SelectTrigger, Select as SelectValue }
export function ErrorState({ title, description }) {
  return React.createElement('div', null, React.createElement('div', null, title),
    description ? React.createElement('div', null, description) : null)
}
export function Skeleton(props) { return React.createElement('div', { ...props }) }
`)
// React dev logs special-props warnings for our stub components reading .key-ish data;
// silence console.error during act() so warnings don't escalate to throws.
const origError = console.error
console.error = (...args) => {
  const s = String(args[0] || '')
  if (s.includes('key') && s.includes('not a prop')) return
  origError(...args)
}

const src = readFileSync(pluginPath, 'utf8')
writeFileSync(underTestPath, src)
const mod = await import(pathToFileURL(underTestPath).href + '?v=' + Date.now())
const contributions = []
mod.default.register({ rest: restStub, register: c => contributions.push(c),
  storage: { get: () => null, set: () => {} } })
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
await act(async () => { renderer = RTR.create(pg.render()); await new Promise(r => setTimeout(r, 300)) })
let txt = () => flatJson(renderer.toJSON()).join('|')

// status chips render with labels
check('status chip "conversing" on live bot', txt().includes('conversing'))
check('status chip age-stamped ready ("ready 1d")', txt().includes('ready 1d'))

// roster capability line on rows
check('capability line from roster on row', txt().includes('handles local generation jobs'))

// click planner row -> Inspector opens with tabs
let plannerBtn = renderer.root.findAll(i => i.type === 'button' && flatJson(i).join(' ').includes('generation jobs') && i.props.onClick)[0]
if (!plannerBtn) {
  const labels = []
  renderer.root.findAll(i => { if (i.type === 'button') { labels.push(flatJson(i).join(' ').slice(0, 50)); } return false })
  console.log('DEBUG buttons:', JSON.stringify(labels.slice(0, 14)))
}
await act(async () => { plannerBtn.props.onClick({ stopPropagation: () => {} }) })
txt = () => flatJson(renderer.toJSON()).join('|')
check('inspector opened with Live tab active', txt().includes('live · refreshes every 4s'))
check('transcript rendered in inspector', txt().includes('hi'))

// switch to Inbox tab
const inboxTab = renderer.root.findAll(i => i.type === 'button' && /Inbox/.test(flatJson(i).join(' ')))[0]
await act(async () => { inboxTab.props.onClick() })
txt = () => flatJson(renderer.toJSON()).join('|')
check('inbox tab shows message + mark-all-read', txt().includes('Mark all read') && txt().includes('note'))

// Configure tab
const cfgTab = renderer.root.findAll(i => i.type === 'button' && /Configure/.test(flatJson(i).join(' ')))[0]
await act(async () => { cfgTab.props.onClick() })
txt = () => flatJson(renderer.toJSON()).join('|')
check('configure tab shows supervisor editor', txt().includes('co-workers (peer relations') && txt().includes('no direct reports'))

// close the inspector so dropdown options don't pollute the text assertions
const closeBtn = renderer.root.findAll(i => i.type === 'button' && flatJson(i).join(' ').trim() === '✕')[0]
if (closeBtn) await act(async () => { closeBtn.props.onClick() })
// search filters rows
const searchInput = renderer.root.findAll(i => i.type === 'input')[0]
await act(async () => { searchInput.props.onChange({ target: { value: 'planner' } }) })
txt = () => flatJson(renderer.toJSON()).join('|')
check('search filters to matching subtree (captain ancestor kept)', txt().includes('Captain') && txt().includes('Planner'))
// the unattached row drops out of view when filtered: the plugin unmounts
// its whole "unassigned" group once no out-of-graph profile survives
// matchesFilter (plugin.js: unassigned.length === 0 -> section not rendered),
// so absence of that section here == absence of the unrelated row itself.
check('unrelated rows hidden by search', !txt().toLowerCase().includes('unassigned'))
await act(async () => { searchInput.props.onChange({ target: { value: '' } }) })

// unassigned attach control exists
const stubSelects = renderer.root.findAll(i => i.type === 'div' && i.props?.['data-select-stub'])
const dbg = txt().toLowerCase()
check('unassigned section offers attach select',
  dbg.includes('unassigned') && stubSelects.length > 0,
  `has-section=${dbg.includes('unassigned')} selects=${stubSelects.length}`)
check('teams section groups by supervisor', txt().includes('teams') && txt().toUpperCase().includes('CAPTAIN'))
check('needs-attention triage section present', /NEEDS ATTENTION/i.test(txt()))

// deck chrome: header stats (inspector currently docked with planner selected)
txt = () => flatJson(renderer.toJSON()).join('|')
check('header shows fleet stats', txt().includes('3|bots') || /3\|.bots/.test(txt()))
check('header shows attention count', txt().includes('2 need attention'))
check('Deck view label present', txt().includes('Fleet Command'))

console.log(`\nLOOP6-TREE SUMMARY: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
