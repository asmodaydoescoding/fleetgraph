// Loop-7 harness: message composer recipient contract (2026-08-23 fixes).
// Regressions encoded:
//   1. delegate frame targets the bot ITSELF (was: decorative subordinate picker)
//   2. talk frame with multiple peers shows a REAL recipient picker and the
//      choice is transmitted to /send (was: picker ignored, backend got peers[0])
//   3. supervisor frame resolves upward; no client recipient sent
//   4. Send disabled on empty text; result line renders queued activation
//   5. peer-less bot: talk frame shows reachability hint, Send stays disabled
// Paths come from the shared portable helper, so any checkout runs this
// harness unmodified. Fixtures come from the shared generic-fleet builders
// over the five public role identities only: planner is the multi-peer
// member (report: reviewer, peers: research + builder) and reviewer is the
// peerless leaf member.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { composerOverview, composerRoster } from './helpers/generic-fleet.mjs'
import { pluginPath, sdkStubPath, underTestPath, prepareHarnessDirs } from './helpers/paths.mjs'
const require = createRequire(import.meta.url)
const React = require('react')
const RTR = require('react-test-renderer')
const rtrAct = RTR.act

// Composer fixture from the shared builders: planner is the multi-peer member
// (report: reviewer, peers: research + builder); reviewer is the peerless leaf.
const overviewData = composerOverview()
const rosterData = composerRoster()

let lastSendBody = null
function restStub(path, opts = {}) {
  if (path.startsWith('/overview')) return Promise.resolve(overviewData)
  if (path.startsWith('/roster')) return Promise.resolve(rosterData)
  if (path.startsWith('/traffic')) return Promise.resolve({ messages: [] })
  if (path.includes('/messages')) return Promise.resolve({ messages: [] })
  if (path.startsWith('/inbox/')) return Promise.resolve({ messages: [] })
  if (path.startsWith('/avatar/')) return Promise.resolve({ found: false })
  if (path.startsWith('/sessions/tail')) return Promise.resolve({ sessions: {} })
  if (path.startsWith('/send')) {
    lastSendBody = opts.body
    return Promise.resolve({ ok: true, sender: 'x', recipient: opts.body.recipient || (opts.body.kind === 'delegate' ? opts.body.to : 'resolved'), frame: opts.body.kind, edge: 'peer', delivery: { mode: 'live', state: 'queued' } })
  }
  return Promise.resolve({})
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
export const host = { request: () => Promise.resolve({ providers: [] }), onEvent: () => () => {}, notify: () => {} }
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
// Radix-faithful Select: the ROOT select is the one carrying onValueChange
// (the plugin's wrapper passes it only to SelectSdk). Trigger/Content/Item
// share this same component, so we walk the element tree: an element whose
// type is Select itself and whose children is a string = a SelectItem leaf.
export function Select(props) {
  if (props.onValueChange) {
    const opts = []
    const walk = (n) => {
      if (!n) return
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (typeof n === 'object' && n.type === Select && n.props) {
        if (typeof n.props.children === 'string' || typeof n.props.children === 'number') {
          opts.push({ value: n.props.value, label: String(n.props.children) })
        } else walk(n.props.children)
      } else if (typeof n === 'object' && n.props && n.props.children) {
        walk(n.props.children)
      }
    }
    walk(props.children)
    return React.createElement('select', { 'data-composer-select': true, value: props.value ?? '',
      onChange: e => props.onValueChange(e.target.value) },
      opts.map((o, i) => React.createElement('option', { key: i, value: o.value }, o.label)))
  }
  // Trigger/Content/Item pass-through containers (rendered only inside root)
  return React.createElement('span', null, props.children)
}
export { Select as SelectSdk, Select as SelectContent, Select as SelectItem, Select as SelectTrigger, Select as SelectValue }
export function ErrorState({ title, description }) {
  return React.createElement('div', null, React.createElement('div', null, title),
    description ? React.createElement('div', null, description) : null)
}
export function Skeleton(props) { return React.createElement('div', { ...props }) }
`)
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

// open inspector on planner (the multi-peer member)
const plannerBtn = renderer.root.findAll(i => i.type === 'button' && flatJson(i).join(' ').includes('multi-peer test member') && i.props.onClick)[0]
check('planner card found in deck', !!plannerBtn)
await act(async () => { plannerBtn.props.onClick({ stopPropagation: () => {} }) })
// switch to Message tab
const msgTab = renderer.root.findAll(i => i.type === 'button' && flatJson(i).join(' ').trim() === 'Message')[0]
check('Message tab present in inspector', !!msgTab)
await act(async () => { msgTab.props.onClick() })
txt = () => flatJson(renderer.toJSON()).join('|')
check('composer mounted (frame picker visible)', txt().includes('frame') && txt().includes('recipient'))

const selects = () => renderer.root.findAll(i => i.type === 'select' && i.props['data-composer-select'])
const frameSelect = () => selects().find(s => s.findAll(o => o.type === 'option' && o.props.value === 'talk').length > 0)
const recipientSelect = () => selects().find(s => s.findAll(o => o.type === 'option' && o.props.value === 'research').length > 0)
const sendBtn = () => renderer.root.findAll(i => i.type === 'button' && flatJson(i).join(' ').includes('Start conversation'))[0]

// 1. talk (default frame) with TWO peers -> real recipient picker with both peers
check('talk frame shows recipient picker (2 peers)', !!recipientSelect(),
  `selects=${selects().length}`)
if (recipientSelect()) {
  const vals = recipientSelect().findAll(o => o.type === 'option').map(o => o.props.value)
  check('recipient picker offers both peers', vals.includes('research') && vals.includes('builder'), `vals=${vals}`)
}

// 2. Send disabled on empty text
check('Send disabled with empty text', sendBtn()?.props.disabled === true)

// 3. type text -> STILL disabled: with 2 peers the operator must pick a
//    recipient first (auto-picking peers[0] would silently hit the wrong bot)
const ta = renderer.root.findAll(i => i.type === 'textarea')[0]
await act(async () => { ta.props.onChange({ target: { value: 'hello research' } }) })
check('Send stays disabled until recipient picked (multi-peer)', sendBtn()?.props.disabled === true)

// 4. pick a peer explicitly -> enabled; send transmits the choice
await act(async () => { recipientSelect().props.onChange({ target: { value: 'research' } }) })
check('Send enabled after recipient pick', sendBtn()?.props.disabled === false)
lastSendBody = null
await act(async () => { sendBtn().props.onClick() })
check('talk send transmits chosen recipient (research)',
  lastSendBody && lastSendBody.kind === 'talk' && lastSendBody.live === true && lastSendBody.recipient === 'research' && lastSendBody.to === 'planner',
  JSON.stringify(lastSendBody))
check('result line echoes queued activation', txt().includes('queued → research'), txt().match(/queued[^|]*/)?.[0] || 'no queued label')

// 5. switch to the OTHER peer -> recipient follows the picker (onSuccess
//    cleared the text, so retype first)
await act(async () => { ta.props.onChange({ target: { value: 'hello builder' } }) })
await act(async () => { recipientSelect().props.onChange({ target: { value: 'builder' } }) })
lastSendBody = null
await act(async () => { sendBtn().props.onClick() })
check('second peer pick transmitted (recipient=builder)',
  lastSendBody && lastSendBody.recipient === 'builder', JSON.stringify(lastSendBody))

// 5. delegate frame -> targets the bot ITSELF, no subordinate picker
await act(async () => { frameSelect().props.onChange({ target: { value: 'delegate' } }) })
txt = () => flatJson(renderer.toJSON()).join('|')
check('delegate frame shows bot itself as recipient (→ planner)', txt().includes('→ planner'),
  txt().match(/→[^|]*/)?.[0] || 'no arrow line')
check('delegate frame has NO recipient select', !recipientSelect(), `selects=${selects().length}`)
lastSendBody = null
await act(async () => { sendBtn().props.onClick() })
check('delegate send: kind=delegate, no recipient field',
  lastSendBody && lastSendBody.kind === 'delegate' && !('recipient' in lastSendBody),
  JSON.stringify(lastSendBody))

// 6. supervisor frame -> resolves upward to captain
await act(async () => { frameSelect().props.onChange({ target: { value: 'supervisor' } }) })
txt = () => flatJson(renderer.toJSON()).join('|')
check('supervisor frame shows → captain', txt().includes('→ captain'))
lastSendBody = null
await act(async () => { sendBtn().props.onClick() })
check('supervisor send: kind=supervisor, no recipient field',
  lastSendBody && lastSendBody.kind === 'supervisor' && !('recipient' in lastSendBody),
  JSON.stringify(lastSendBody))

// 7. peer-less bot (reviewer): talk frame shows reachability hint, Send disabled
const closeBtn = renderer.root.findAll(i => i.type === 'button' && flatJson(i).join(' ').trim() === '✕')[0]
if (closeBtn) await act(async () => { closeBtn.props.onClick() })
const reviewerBtn = renderer.root.findAll(i => i.type === 'button' && flatJson(i).join(' ').includes('peerless leaf member') && i.props.onClick)[0]
check('reviewer card found', !!reviewerBtn)
await act(async () => { reviewerBtn.props.onClick({ stopPropagation: () => {} }) })
const msgTab2 = renderer.root.findAll(i => i.type === 'button' && flatJson(i).join(' ').trim() === 'Message')[0]
await act(async () => { msgTab2.props.onClick() })
txt = () => flatJson(renderer.toJSON()).join('|')
check('peer-less bot: talk hint shown', txt().includes('has no peer relations'), txt().match(/no peer[^|]*/)?.[0] || '')
const ta2 = renderer.root.findAll(i => i.type === 'textarea')[0]
await act(async () => { ta2.props.onChange({ target: { value: 'should not send' } }) })
check('peer-less bot: Send stays disabled even with text', sendBtn()?.props.disabled === true)

console.log(`\nLOOP7-COMPOSER SUMMARY: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
