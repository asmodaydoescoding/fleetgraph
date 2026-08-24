// Loop-8 adversarial harness: state churn + UI precision + keyboard + viewport.
// Every check drives the shipped plugin through its registered route contribution.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { pluginPath, underTestPath, sdkStubPath, prepareHarnessDirs } from './helpers/paths.mjs'
import { CAPTAIN, PLANNER, RESEARCH, BUILDER, REVIEWER } from './helpers/generic-fleet.mjs'

const require = createRequire(import.meta.url)
const React = require('react')
const RTR = require('react-test-renderer')
const rtrAct = RTR.act

const eventHandlers = new Map()
globalThis.window = {
  addEventListener(type, fn) {
    if (!eventHandlers.has(type)) eventHandlers.set(type, new Set())
    eventHandlers.get(type).add(fn)
  },
  removeEventListener(type, fn) { eventHandlers.get(type)?.delete(fn) },
  dispatchEvent(event) {
    for (const fn of [...(eventHandlers.get(event.type) || [])]) fn(event)
    return true
  },
}
globalThis.document = {
  head: { appendChild() {} },
  createElement(tag) {
    return { tagName: tag.toUpperCase(), textContent: '', remove() {}, style: {} }
  },
}

const clone = value => structuredClone(value)
// Generic fixtures: public role identities only (see helpers/generic-fleet.mjs).
const baseNodes = {
  [CAPTAIN]: {
    supervisor: null, subordinates: [PLANNER], peers: [], depth: 0,
    inbox: 0, unread: 0, in_graph: true, has_avatar: false, color: 'var(--ui-accent)',
    title: 'Captain', description: 'coordinates the fleet',
    latest_session: { status: 'active', last_active: Math.floor(Date.now() / 1000) - 5 },
  },
  [PLANNER]: {
    supervisor: CAPTAIN, subordinates: [], peers: [], depth: 1,
    inbox: 0, unread: 0, in_graph: true, has_avatar: false, color: 'var(--ui-success)',
    title: 'Planner', description: 'handles delegated work',
    latest_session: { status: 'active', last_active: Math.floor(Date.now() / 1000) - 5 },
  },
  [BUILDER]: {
    supervisor: null, subordinates: [RESEARCH], peers: [], depth: 0,
    inbox: 0, unread: 0, in_graph: true, has_avatar: false, color: 'var(--ui-warning)',
    title: 'Builder', description: 'separate subtree',
    latest_session: { status: 'complete', last_active: Math.floor(Date.now() / 1000) - 3600 },
  },
  [RESEARCH]: {
    supervisor: BUILDER, subordinates: [], peers: [], depth: 1,
    inbox: 0, unread: 0, in_graph: true, has_avatar: false, color: 'var(--ui-danger)',
    title: 'Research', description: 'separate subtree leaf', latest_session: null,
  },
  [REVIEWER]: {
    supervisor: null, subordinates: [], peers: [], depth: null,
    inbox: 0, unread: 0, in_graph: false, has_avatar: false, color: 'var(--ui-text-quaternary)',
    title: 'Reviewer', description: 'profile outside the graph', latest_session: null,
  },
}
const roster = Object.fromEntries(Object.entries(baseNodes).map(([name, node]) => [name, {
  name, title: node.title, summary: node.description, keywords: [],
}]))

const keys = {
  overview: JSON.stringify(['fleet-graph-overview']),
  traffic: JSON.stringify(['fleet-traffic']),
  roster: JSON.stringify(['fleet-roster']),
  tail: JSON.stringify(['fleet-tail-msgs', CAPTAIN]),
}
const control = {
  data: {
    [keys.overview]: { nodes: clone(baseNodes) },
    [keys.traffic]: { messages: [] },
    [keys.roster]: { roster },
  },
  listeners: new Set(),
  storageWrites: [],
  restCalls: [],
  hostEvents: new Set(),
  invalidations: [],
  publish(key, value) {
    this.data[key] = value
    for (const fn of [...this.listeners]) fn(key, value)
  },
}
globalThis.__fleetLoop8 = control

prepareHarnessDirs()
writeFileSync(sdkStubPath, `
import React from 'react'
const ctl = globalThis.__fleetLoop8
const has = key => Object.prototype.hasOwnProperty.call(ctl.data, key)
export function useQuery({ queryKey, queryFn, enabled = true }) {
  const key = JSON.stringify(queryKey)
  const [state, setState] = React.useState(() => enabled && has(key)
    ? { data: ctl.data[key], isLoading: false, isError: false }
    : { data: undefined, isLoading: !!enabled, isError: false })
  React.useEffect(() => {
    if (!enabled) { setState({ data: undefined, isLoading: false, isError: false }); return }
    let alive = true
    const listener = (changed, value) => {
      if (alive && changed === key) setState({ data: value, isLoading: false, isError: false })
    }
    ctl.listeners.add(listener)
    if (has(key)) setState({ data: ctl.data[key], isLoading: false, isError: false })
    else Promise.resolve(queryFn()).then(
      data => { ctl.data[key] = data; if (alive) setState({ data, isLoading: false, isError: false }) },
      error => { if (alive) setState({ data: undefined, isLoading: false, isError: true, error }) },
    )
    return () => { alive = false; ctl.listeners.delete(listener) }
  }, [key, enabled])
  return {
    ...state,
    refetch: async () => {
      try {
        const data = await queryFn()
        ctl.data[key] = data
        setState({ data, isLoading: false, isError: false })
        return { data }
      } catch (error) {
        setState(s => ({ ...s, isLoading: false, isError: true, error }))
        return { error }
      }
    },
  }
}
export function useMutation({ mutationFn, onSuccess, onError }) {
  const [isPending, setPending] = React.useState(false)
  return {
    isPending,
    mutate: value => {
      setPending(true)
      Promise.resolve(mutationFn(value)).then(
        data => { setPending(false); onSuccess?.(data) },
        error => { setPending(false); onError?.(error) },
      )
    },
  }
}
export const useQueryClient = () => ({
  invalidateQueries: query => { ctl.invalidations.push(query) },
  setQueryData: (queryKey, updater) => {
    const key = JSON.stringify(queryKey)
    const old = ctl.data[key]
    const value = typeof updater === 'function' ? updater(old) : updater
    ctl.publish(key, value)
  },
})
export const cn = (...values) => values.filter(Boolean).join(' ')
export const host = {
  request: (method) => Promise.resolve(method === 'model.options' ? { providers: [] } : { skills: [], toolsets: [] }),
  onEvent: (type, fn) => { ctl.hostEvents.add(fn); return () => ctl.hostEvents.delete(fn) },
  notify: () => {},
}
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export function SegmentedControl({ options, value, onChange, className }) {
  return React.createElement('div', { className, 'data-slot': 'segmented' }, options.map(option =>
    React.createElement('button', {
      key: option.id, type: 'button', onClick: () => onChange(option.id),
      'aria-pressed': value === option.id,
    }, option.label)))
}
export function Button(props) {
  const { size, variant, ...rest } = props
  return React.createElement('button', { ...rest, 'data-size': size, 'data-variant': variant })
}
export function Input(props) { return React.createElement('input', { ...props, 'data-slot': 'input' }) }
export function Textarea(props) { return React.createElement('textarea', { ...props, 'data-slot': 'textarea' }) }
export function Checkbox(props) { return React.createElement('input', { type: 'checkbox', ...props, 'data-slot': 'checkbox' }) }
export function Dialog({ open, onOpenChange, children }) {
  React.useEffect(() => {
    if (!open) return
    const close = event => { if (event.key === 'Escape') onOpenChange?.(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open, onOpenChange])
  return open ? React.createElement('div', { 'data-slot': 'dialog', 'data-state': 'open' }, children) : null
}
export function DialogContent({ children, className }) { return React.createElement('div', { className, 'data-slot': 'dialog-content' }, children) }
export function DialogHeader({ children, className }) { return React.createElement('div', { className, 'data-slot': 'dialog-header' }, children) }
export function DialogTitle({ children, className }) { return React.createElement('h2', { className, 'data-slot': 'dialog-title' }, children) }
export function DialogDescription({ children, className }) { return React.createElement('p', { className, 'data-slot': 'dialog-description' }, children) }
export function DialogFooter({ children, className }) { return React.createElement('div', { className, 'data-slot': 'dialog-footer' }, children) }
export function Select(props) {
  if (props.onValueChange) {
    const options = []
    const walk = node => {
      if (!node) return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (typeof node === 'object' && node.type === Select && node.props) {
        if (typeof node.props.children === 'string' || typeof node.props.children === 'number') {
          options.push({ value: node.props.value, label: String(node.props.children) })
        } else walk(node.props.children)
      } else if (typeof node === 'object' && node.props) walk(node.props.children)
    }
    walk(props.children)
    return React.createElement('select', {
      value: props.value ?? '', onChange: event => props.onValueChange(event.target.value),
      'data-slot': 'select-root',
    }, options.map((option, index) => React.createElement('option', { key: index, value: option.value }, option.label)))
  }
  return React.createElement('span', { 'data-slot': 'select-part' }, props.children)
}
export { Select as SelectSdk, Select as SelectContent, Select as SelectItem, Select as SelectTrigger, Select as SelectValue }
export function ErrorState({ title, description }) { return React.createElement('div', { 'data-slot': 'error-state' }, title, description) }
export function Skeleton({ className }) { return React.createElement('div', { className, 'data-slot': 'skeleton' }) }
`)

const source = readFileSync(pluginPath, 'utf8')
writeFileSync(underTestPath, source)
const warnings = []
const originalError = console.error
console.error = (...args) => {
  const message = args.map(String).join(' ')
  if (message.includes('Each child in a list should have a unique')) warnings.push(message)
  originalError(...args)
}

function restStub(path, options = {}) {
  control.restCalls.push({ path, options })
  if (path.startsWith('/overview')) return Promise.resolve(control.data[keys.overview])
  if (path.startsWith('/traffic')) return Promise.resolve(control.data[keys.traffic])
  if (path.startsWith('/roster')) return Promise.resolve(control.data[keys.roster])
  if (path.startsWith('/sessions/')) return Promise.resolve({ messages: [] })
  if (path.startsWith('/inbox/')) return Promise.resolve({ messages: [] })
  if (path.startsWith('/avatar/')) return Promise.resolve({ found: false })
  if (path.startsWith('/graph')) return Promise.resolve({ ok: true })
  return Promise.resolve({})
}

const restoredViewport = { tx: 17, ty: 23, scale: 0.8 }
const storage = {
  get: key => key === 'canvas-view' ? JSON.stringify(restoredViewport) : null,
  set(key, value) { control.storageWrites.push({ key, value }) },
}
const mod = await import(pathToFileURL(underTestPath).href + '?v=' + Date.now())
const contributions = []
mod.default.register({ rest: restStub, register: contribution => contributions.push(contribution), storage })
const page = contributions.find(c => c.area === 'routes' && c.data?.path === '/fleet-graph')

function flatten(node, out = []) {
  if (!node) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach(item => flatten(item, out)); return out }
  if (node.children) flatten(node.children, out)
  return out
}
const textOf = node => flatten(node).join(' ')
const classHas = (node, name) => String(node.props?.className || '').split(/\s+/).includes(name)
const byClass = name => renderer.root.findAll(node => classHas(node, name))
const pathsByClass = name => renderer.root.findAll(node => node.type === 'path' && classHas(node, name))
const buttonsByText = label => renderer.root.findAll(node => node.type === 'button' && textOf(node).trim() === label)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function act(fn = async () => {}) {
  await rtrAct(async () => { await fn(); await delay(40) })
}
async function publish(key, value) {
  await act(async () => { control.publish(key, value) })
}
function dispatch(type, fields = {}) {
  window.dispatchEvent({ type, ...fields })
}
function emitHostEvent(event) {
  for (const fn of [...control.hostEvents]) fn(event)
}

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  const good = !!ok
  passed += Number(good)
  failed += Number(!good)
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

let renderer
await act(async () => { renderer = RTR.create(page.render()) })
check('page renders through registered route', byClass('fleet-graph-root').length === 1)
check('conversing status chips cover active member and active team lead', byClass('fleet-chip-conversing').length >= 2,
  `chips=${byClass('fleet-chip-conversing').length}`)
check('conversing chip has an actual animation rule', /\.fleet-chip-conversing\s*\{[^}]*animation:/s.test(source))
check('inspector empty state uses precision class', byClass('fleet-inspector-empty').length === 1)
check('inspector empty state includes its visual cue', byClass('fleet-inspector-empty-icon').length === 1)

// Badge appears once unread becomes nonzero, then survives count-only refetches
// without remounting (which would replay the entrance animation).
const unreadNodes = clone(baseNodes)
unreadNodes[PLANNER].unread = 2
unreadNodes[PLANNER].inbox = 2
await publish(keys.overview, { nodes: unreadNodes })
let badges = renderer.root.findAll(node => node.type === 'button' && String(node.props.title || '').startsWith('Mark 2 read'))
check('unread badges appear with exact count', badges.length > 0, `badges=${badges.length}`)
const badgeInstances = [...badges]
const unreadNodes2 = clone(unreadNodes)
unreadNodes2[PLANNER].unread = 3
unreadNodes2[PLANNER].inbox = 3
await publish(keys.overview, { nodes: unreadNodes2 })
badges = renderer.root.findAll(node => node.type === 'button' && String(node.props.title || '').startsWith('Mark 3 read'))
check('count-only refetch preserves badge instances',
  badges.length === badgeInstances.length && badges.every((node, index) => node === badgeInstances[index]),
  `before=${badgeInstances.length} after=${badges.length}`)

// Search to an empty result: sections disappear, explicit empty copy remains,
// and the dock has the designed inspector placeholder.
const search = renderer.root.findAll(node => node.type === 'input' && node.props.placeholder?.startsWith('search bots'))[0]
await act(async () => { search.props.onChange({ target: { value: 'definitely-no-match' } }) })
check('empty search renders bounded no-match state', textOf(renderer.toJSON()).includes('no bots match the current filter'))
check('empty search keeps designed inspector placeholder', byClass('fleet-inspector-empty').length === 1)
await act(async () => { search.props.onChange({ target: { value: '' } }) })

// Create dialog honors Escape through its onOpenChange contract.
await act(async () => { buttonsByText('+ New member')[0].props.onClick() })
check('create dialog opens', renderer.root.findAll(node => node.props?.['data-slot'] === 'dialog').length === 1)
await act(async () => { dispatch('keydown', { key: 'Escape' }) })
check('Escape closes create dialog', renderer.root.findAll(node => node.props?.['data-slot'] === 'dialog').length === 0)

// Canvas: select one branch. Its own edge stays emphasized while unrelated
// context dims; role identities come from the shared generic fleet.
await act(async () => { buttonsByText('Graph')[0].props.onClick() })
const viewportTransform = () => renderer.root.findAll(node => node.type === 'g' && /^translate\(.+\) scale\(/.test(String(node.props.transform || '')))[0]?.props.transform
check('stored canvas viewport is restored', viewportTransform() === 'translate(17,23) scale(0.8)', viewportTransform() || 'no transform')
const firstCanvasWrite = control.storageWrites.find(write => write.key === 'canvas-view')
check('restore does not overwrite storage with the default viewport first',
  firstCanvasWrite?.value === JSON.stringify(restoredViewport), JSON.stringify(firstCanvasWrite))
const nodeGroup = title => renderer.root.findAll(node => node.type === 'g' && typeof node.props.onClick === 'function' && textOf(node).includes(title))[0]
await act(async () => { nodeGroup('Captain').props.onClick() })
check('canvas click selects node', renderer.root.findAll(node => node.type === 'rect' && node.props.stroke === 'var(--stroke-accent)').length === 1)
check('selected branch keeps one non-dimmed edge', pathsByClass('fleet-edge-idle').length === 1, `idle=${pathsByClass('fleet-edge-idle').length}`)
check('unrelated branch dims', pathsByClass('fleet-edge-dimmed').length === 1, `dimmed=${pathsByClass('fleet-edge-dimmed').length}`)

// A transcript update can replace the latest row in place and may not carry
// an id during a gateway transition. It must render without a key warning and
// remain visible as the newest text.
await publish(keys.tail, { messages: [{ role: 'assistant', text: 'first reply', ts: 't1' }] })
check('latest transcript message renders without an id', textOf(renderer.toJSON()).includes('first reply'))
await publish(keys.tail, { messages: [{ role: 'assistant', text: 'latest reply', ts: 't1' }] })
check('in-place latest transcript update is rendered',
  textOf(renderer.toJSON()).includes('latest reply') && !textOf(renderer.toJSON()).includes('first reply'))
await act(async () => { emitHostEvent({ type: 'message.complete', profile: CAPTAIN }) })
check('message completion invalidates transcript and overview',
  control.invalidations.some(q => JSON.stringify(q.queryKey) === JSON.stringify(['fleet-tail-msgs'])) &&
  control.invalidations.some(q => JSON.stringify(q.queryKey) === JSON.stringify(['fleet-graph-overview'])))

// Deck edits are draft-backed. Graph must render the same unsaved topology,
// rather than re-reading only the server snapshot.
await act(async () => { buttonsByText('Configure')[0].props.onClick() })
const supervisorSelect = renderer.root.findAll(node => node.type === 'select' && node.props['data-slot'] === 'select-root')[0]
await act(async () => { supervisorSelect.props.onChange({ target: { value: BUILDER } }) })
check('graph reflects an unsaved deck rewire',
  pathsByClass('fleet-edge-idle').length === 2 && pathsByClass('fleet-edge-dimmed').length === 1,
  `idle=${pathsByClass('fleet-edge-idle').length} dimmed=${pathsByClass('fleet-edge-dimmed').length}`)
await act(async () => { buttonsByText('discard')[0].props.onClick() })

// A traffic update on a generic profile pair must light the exact edge without
// resetting the zoom/pan viewport.
const canvasHost = renderer.root.findAll(node => node.type === 'div' && typeof node.props.onWheel === 'function')[0]
await act(async () => {
  canvasHost.props.onWheel({
    preventDefault() {}, ['del' + 'taY']: -1, clientX: 200, clientY: 100,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
  })
})
const zoomed = viewportTransform()
check('wheel zoom changes and persists viewport', /scale\(0\.896/.test(zoomed || '') && control.storageWrites.length > 0, zoomed || 'no transform')
await publish(keys.traffic, { messages: [{ from: CAPTAIN, to: PLANNER, ts: Date.now(), kind: 'talk' }] })
check('dashed profile names produce talking edge', pathsByClass('fleet-edge-talk').length === 1, `talk=${pathsByClass('fleet-edge-talk').length}`)
check('traffic refetch preserves viewport', viewportTransform() === zoomed, `${viewportTransform()} vs ${zoomed}`)
check('graph node labels use halo class', byClass('fleet-node-label-halo').length >= 2, `labels=${byClass('fleet-node-label-halo').length}`)

// Escape from the canvas closes the inspector AND clears selection; leaving a
// stale selection would dim every unrelated edge indefinitely.
await act(async () => { dispatch('keydown', { key: 'Escape' }) })
check('Escape clears canvas selection', renderer.root.findAll(node => node.type === 'rect' && node.props.stroke === 'var(--stroke-accent)').length === 0)

// Selected node vanishes between overview polls. The drawer and stale edge
// emphasis must disappear without a crash. Traffic for a gone endpoint must
// never create an orphan glow.
await act(async () => { nodeGroup('Captain').props.onClick() })
const reducedNodes = clone(baseNodes)
delete reducedNodes[CAPTAIN]
delete reducedNodes[PLANNER]
await publish(keys.overview, { nodes: reducedNodes })
check('selected node removal does not crash page', byClass('fleet-graph-root').length === 1)
check('selected node removal clears stale dimming', pathsByClass('fleet-edge-dimmed').length === 0 && pathsByClass('fleet-edge-idle').length === 1,
  `idle=${pathsByClass('fleet-edge-idle').length} dimmed=${pathsByClass('fleet-edge-dimmed').length}`)
check('traffic with missing endpoint renders no orphan glow', pathsByClass('fleet-edge-talk').length === 0)

// Built-in profile deletion is observed on the next overview refresh. The
// deleted profile must leave both the rendered tree and all picker options,
// without disturbing the remaining profiles.
const afterExternalDelete = clone(reducedNodes)
delete afterExternalDelete[BUILDER]
delete afterExternalDelete[RESEARCH]
await publish(keys.overview, { nodes: afterExternalDelete })
check('external profile deletion removes graph/tree member',
  !textOf(renderer.toJSON()).includes('Builder') && !textOf(renderer.toJSON()).includes('Research'))
check('external profile deletion removes hierarchy options',
  renderer.root.findAll(node => node.type === 'option' &&
    [BUILDER, RESEARCH].includes(node.props.value)).length === 0)

// Rendering output must be pristine. A warning is a release failure because
// React dev-mode warnings become thrown act() failures in stricter hosts.
check('no React missing-key warnings', warnings.length === 0, `warnings=${warnings.length}`)
check('chain save sends the graph payload once',
  /mutationFn: payload => api\.rest\('\/graph', \{ method: 'PUT', body: payload \}\)/.test(source),
  'nested { nodes: payload } would create literal nodes/relations graph members')
check('hierarchy removal sends explicit remove payload',
  /body: \{ nodes, relations, remove: \[name\] \}/.test(source),
  'profile folders stay intact while graph membership is removed')

console.error = originalError
console.log(`\nLOOP8 SUMMARY: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
