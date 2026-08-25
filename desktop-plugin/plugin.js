/**
 * Fleetgraph — the org chart IS the interface.
 * ~/.hermes/desktop-plugins/fleet-graph/plugin.js
 *
 * ONE view: the command tree, drawn as an interactive SVG canvas where each
 * bot is a node (real avatar or shape+color fallback). Click a node = expand
 * the detail panel: identity, runtime config, SOUL editor, supervisor picker,
 * peer relations, inbox with read-state. Create new profiles from here too
 * (profiles.create / profiles.configure). No tabs.
 *
 * Live activity tails: host.onEvent('*') streams tool.start/complete +
 * message.start/complete events stamped with `event.profile` — used to paint
 * per-node "thinking / running X / idle" status without a per-bot socket.
 *
 * LOADER CONTRACT: Hermes Desktop extracts module specifiers with a
 * syntax-anchored matcher, not a full JavaScript parser. Keep module imports
 * limited to the SDK and React surfaces supported by the host, and avoid
 * import-declaration-shaped examples in comments or strings. The repository
 * audit checks the exact loader-shaped import count.
 */
import {
  cn, host, useMutation, useQuery, useQueryClient,
  ROUTES_AREA, SIDEBAR_NAV_AREA,
  SegmentedControl, Button, Input, Textarea, Checkbox,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
  Select as SelectSdk, SelectContent, SelectItem, SelectTrigger, SelectValue,
  ErrorState, Skeleton
} from '@hermes/plugin-sdk'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import ReactDefault, { useEffect, useMemo, useRef, useState } from 'react'

const ID = 'fleet-graph'
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
let api = null // the plugin ctx, bound in register()

// ─── design tokens (Astryx-derived) ───────────────────────────────
// Single source of truth for color/motion/radius vocabulary. All color values
// resolve through host theme tokens so dark/light/custom themes stay native.
const TOKENS_CSS = `
.fleet-graph-root {
  --fg-accent: var(--ui-accent);
  --fg-success: color-mix(in srgb, var(--ui-green) 90%, var(--foreground));
  --fg-warning: color-mix(in srgb, var(--ui-yellow) 75%, var(--foreground));
  --fg-danger: var(--ui-red);
  --fg-primary: var(--foreground);
  --fg-secondary: var(--ui-text-secondary);
  --fg-tertiary: var(--ui-text-secondary);
  --fg-quaternary: var(--ui-text-secondary);
  --surface-card: var(--ui-bg-editor);
  --surface-canvas: var(--background);
  --stroke: var(--ui-stroke-secondary);
  --stroke-accent: var(--ui-accent);
  --dur-fast: 150ms;
  --dur-medium: 300ms;
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
  --radius-node: 12px;
  --row-h: 36px;
}
/* ── Scrollbars: thin, subtle, theme-aware ── */
.fleet-graph-root ::-webkit-scrollbar { width: 6px; height: 6px; }
.fleet-graph-root ::-webkit-scrollbar-track { background: transparent; }
.fleet-graph-root ::-webkit-scrollbar-thumb {
  background: var(--stroke);
  border-radius: 9999px;
}
.fleet-graph-root ::-webkit-scrollbar-thumb:hover { background: var(--fg-quaternary); }
/* ── Focus-visible rings for keyboard navigation ── */
.fleet-graph-root button:focus-visible,
.fleet-graph-root select:focus-visible,
.fleet-graph-root input:focus-visible,
.fleet-graph-root textarea:focus-visible {
  outline: 2px solid var(--fg-accent);
  outline-offset: 2px;
}
/* Radix Select portals its popup to <body> / the dialog container — outside
   .fleet-graph-root — so the plugin's tokens don't resolve there. The app's
   Tailwind-v4 tokens are --color-* prefixed; reference those (with literal
   fallbacks) so options are readable in BOTH themes. */
[data-slot="select-content"], [data-radix-select-content], [role="listbox"] {
  background-color: var(--color-popover, var(--background)) !important;
  color: var(--color-popover-foreground, var(--color-foreground)) !important;
  border: 1px solid var(--color-border, var(--ui-stroke-secondary)) !important;
}
[data-slot="select-item"], [role="option"] {
  color: var(--color-popover-foreground, var(--color-foreground)) !important;
}
[data-slot="select-item"][data-highlighted], [data-slot="select-item"]:hover,
[data-slot="select-item"][data-state="checked"],
[role="option"][data-highlighted], [role="option"]:hover {
  background-color: var(--color-accent, var(--ui-accent)) !important;
  color: var(--color-accent-foreground, var(--foreground)) !important;
}
.fleet-graph-root button, .fleet-graph-root select, .fleet-graph-root input, .fleet-graph-root textarea {
  transition: background-color var(--dur-fast) var(--ease-out),
              border-color var(--dur-fast) var(--ease-out),
              color var(--dur-fast) var(--ease-out),
              opacity var(--dur-fast) var(--ease-out);
}
.fleet-graph-root svg rect, .fleet-graph-root svg circle, .fleet-graph-root svg line, .fleet-graph-root svg text {
  transition: stroke var(--dur-fast) var(--ease-out),
              fill var(--dur-fast) var(--ease-out),
              opacity var(--dur-fast) var(--ease-out);
}
/* drawer slide + dialog fade use the medium band */
.fleet-tail { transition: transform var(--dur-medium) var(--ease-out); }
.fleet-dialog { transition: opacity var(--dur-medium) var(--ease-out); }
.fleet-dialog-panel { transition: opacity var(--dur-medium) var(--ease-out), transform var(--dur-medium) var(--ease-out); }
/* discussion glow: flowing dashes on edges between bots that are talking */
@keyframes fleet-flow {
  to { stroke-dashoffset: -24; }
}
.fleet-graph-root .fleet-edge-talk {
  stroke: var(--fg-accent);
  stroke-width: 2;
  stroke-dasharray: 6, 6;
  animation: fleet-flow 0.9s linear infinite;
  filter: drop-shadow(0 0 4px var(--fg-accent));
}
/* node pulse for actively-conversing bots */
.fleet-node-talking {
  animation: fleet-node-pulse 1.2s ease-in-out infinite alternate;
}
@keyframes fleet-node-pulse {
  from { filter: drop-shadow(0 0 2px var(--fg-accent)); }
  to   { filter: drop-shadow(0 0 7px var(--fg-accent)); }
}
/* status chip: conversing breathing pulse */
@keyframes fleet-chip-breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.04); }
}
.fleet-chip-conversing {
  animation: fleet-chip-breathe 2s var(--ease-out) infinite;
}
.fleet-chip-conversing > span:first-child {
  box-shadow: 0 0 6px var(--fg-accent);
}
.fleet-chip-interrupted { opacity: 0.8; }
/* unread pill entrance */
@keyframes fleet-badge-pop {
  from { transform: scale(0.7); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
.fleet-badge-new {
  animation: fleet-badge-pop 150ms var(--ease-out);
}
/* graph node label halo for legibility over edges */
.fleet-node-label-halo {
  paint-order: stroke fill;
  stroke: var(--surface-canvas);
  stroke-width: 3px;
  stroke-linejoin: round;
}
/* graph node card depth */
.fleet-graph-root .fleet-node-card {
  filter: drop-shadow(0 1px 2px color-mix(in srgb, var(--foreground) 24%, transparent));
  transition: filter var(--dur-fast) var(--ease-out);
}
.fleet-graph-root .fleet-node-card:hover {
  filter: drop-shadow(0 3px 8px color-mix(in srgb, var(--foreground) 32%, transparent));
}
/* graph edge dimming for non-selected context */
.fleet-graph-root .fleet-edge-dimmed { opacity: 0.15; }
.fleet-graph-root .fleet-edge-idle { opacity: 0.3; }
/* inspector placeholder */
.fleet-inspector-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--fg-quaternary);
  text-align: center;
  padding: 24px;
}
.fleet-inspector-empty-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1.5px dashed var(--stroke);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
/* section header accent tick */
.fleet-section-tick {
  display: inline-block;
  width: 2px;
  height: 12px;
  border-radius: 1px;
  margin-right: 6px;
  vertical-align: middle;
}
/* count pill for section headers */
.fleet-count-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9999px;
  font-size: 0.625rem;
  font-weight: 500;
  background: var(--stroke);
  color: var(--fg-secondary);
}
`

function useTokens() {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const el = document.createElement('style')
    el.textContent = TOKENS_CSS
    document.head.appendChild(el)
    return () => el.remove()
  }, [])
}


// ─── data ──────────────────────────────────────────────────────────
function useOverview() {
  return useQuery({
    queryKey: ['fleet-graph-overview'],
    queryFn: () => api.rest('/overview'),
    refetchInterval: 8000,
  })
}

function useAvatar(name, enabled) {
  return useQuery({
    queryKey: ['fleet-avatar', name],
    queryFn: () => api.rest(`/avatar/${name}`),
    enabled: !!enabled,
    staleTime: 5 * 60 * 1000,
  })
}

function useInbox(profile, open) {
  return useQuery({
    queryKey: ['fleet-inbox', profile],
    queryFn: () => api.rest(`/inbox/${profile}`),
    enabled: !!profile && !!open,
    refetchInterval: 6000,
  })
}

// recent inter-agent messages — powers the discussion glow on edges
function useTraffic() {
  return useQuery({
    queryKey: ['fleet-traffic'],
    queryFn: () => api.rest('/traffic?window=300'),
    refetchInterval: 5000,
  })
}

// fleet capability roster — what every bot is FOR (drives row subtitles,
// inspector footers, and the routing decision in the ladder)
function useRoster() {
  return useQuery({
    queryKey: ['fleet-roster'],
    queryFn: () => api.rest('/roster'),
    staleTime: 60 * 1000,
  })
}

// ─── backend self-heal ──────────────────────────────────────────────
// The desktop panel loads from desktop-plugins/, but its Python API only
// mounts when this plugin's backend is enabled in config.yaml
// (`plugins.enabled`). A fresh install that skipped that step shows a dead
// view with no hint why. Detect the exact state through the gateway's
// plugins.manage RPC (same primitive Settings -> Plugins uses) and offer a
// one-click enable. If the RPC is unavailable (older gateway), everything
// degrades to the plain error card.
function useBackendHeal(overviewFailed) {
  const qc = useQueryClient()
  const check = useQuery({
    queryKey: ['fleet-backend-state'],
    queryFn: () => host.request('plugins.manage', { action: 'list' }),
    staleTime: 30 * 1000,
    retry: 1,
  })
  const row = useMemo(() => ((check.data?.plugins) || []).find(p =>
    p.key === ID || p.name === ID), [check.data])
  // Three states (issue #3): config-disabled -> offer Enable; enabled but
  // the API still 404s -> ask the live backend to remount its plugin routes;
  // no plugins.manage row (older gateway) or any other case -> plain error
  // card.
  const backendDisabled = !!row && row.status !== 'enabled'
  const backendNeedsRestart = !!overviewFailed && !!row && row.status === 'enabled'
  const enable = useMutation({
    mutationFn: () => host.request('plugins.manage', { action: 'toggle', key: ID, enable: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fleet-backend-state'] })
      host.notify({ kind: 'success', message: 'Backend enabled — press Retry; if the API still sleeps, restart Hermes once so the routes mount.' })
    },
    onError: e => host.notify({ kind: 'error', message: String(e?.message || e) }),
  })
  const remount = useMutation({
    mutationFn: async () => {
      const result = await host.request('plugins.manage', {
        action: 'reload_dashboard_routes',
        confirm: true,
        protocol_version: 1,
      })
      if (result?.protocol !== 'fleet-graph.dashboard-routes' || result?.protocol_version !== 1) {
        throw new Error('Hermes route-remount protocol is unavailable; restart the dashboard once, then press Retry')
      }
      return result
    },
    onSuccess: result => {
      qc.invalidateQueries({ queryKey: ['fleet-backend-state'] })
      qc.invalidateQueries({ queryKey: ['fleet-graph-overview'] })
      host.notify({
        kind: 'success',
        message: `Plugin routes remounted (${result?.count || 0}); retrying the Fleetgraph API.`,
      })
    },
    onError: e => host.notify({ kind: 'error', message: String(e?.message || e) }),
  })
  return { backendDisabled, backendNeedsRestart, enable, remount }
}

/** Edge key for a pair of bots (order-independent). */
const pairKey = (a, b) => [a, b].sort().join('\u0000')

/** Map of pairKey -> {lastTs, count} from the traffic feed. */
function useTrafficIndex() {
  const q = useTraffic()
  return useMemo(() => {
    const idx = {}
    for (const m of (q.data?.messages || [])) {
      if (!m.from || !m.to || m.from === m.to) continue
      const k = pairKey(m.from, m.to)
      const prev = idx[k]
      if (!prev || m.ts > prev.lastTs) {
        idx[k] = { lastTs: m.ts, count: (prev?.count || 0) + 1 }
      } else {
        prev.count++
      }
    }
    return idx
  }, [q.data])
}

// ─── layout: layered DAG, children fan beneath their parents ───────
const RANK_H = 110
const GAP_X = 36

/** Subtree-width layered layout. Each leaf occupies NODE_W + GAP_X of
    horizontal budget; a parent is centered over its children; y = rank *
    RANK_H. Nodes not in the graph are skipped. Cycles are guarded with a
    visiting set so a malformed graph cannot hang the layout. */
function useLayout(nodes) {
  return useMemo(() => {
    const kidsOf = {}
    const roots = []
    for (const [name, n] of Object.entries(nodes)) {
      if (!n.in_graph) continue
      const kids = Object.entries(nodes)
        .filter(([cn2, cd]) => cd.in_graph && cd.supervisor === name)
        .map(([cn2]) => cn2)
      kidsOf[name] = kids.sort()
      if (!n.supervisor) roots.push(name)
    }
    roots.sort()
    // cycle guard: any node reachable from a root is placed there; leftovers
    // (cycles) get appended as pseudo-roots so they still render.
    const placed = new Set()
    const pos = {}

    /** Lays out `name`'s subtree starting at horizontal budget position
        `left`. Returns the total width consumed. Parent centers over kids. */
    const place = (name, depth, left, visiting) => {
      if (visiting.has(name)) return 0 // cycle: contributes no width here
      visiting.add(name)
      const kids = (kidsOf[name] || []).filter(k => !placed.has(k))
      let width = 0
      if (kids.length === 0) {
        width = NODE_W + GAP_X
        pos[name] = { x: left + GAP_X / 2, y: 28 + depth * RANK_H }
      } else {
        let kLeft = left
        for (const k of kids) {
          const w = place(k, depth + 1, kLeft, visiting)
          kLeft += w
          width += w
        }
        // center parent over the children's span
        const firstX = pos[kids[0]].x
        const lastX = pos[kids[kids.length - 1]].x
        pos[name] = { x: (firstX + lastX) / 2, y: 28 + depth * RANK_H }
      }
      placed.add(name)
      visiting.delete(name)
      return width
    }

    let cursorX = 8
    for (const r of roots) {
      const w = place(r, 0, cursorX, new Set())
      cursorX += w
    }
    // leftovers (cycle members / orphans): lay them out on a final extra rank
    const leftover = Object.keys(nodes).filter(n => nodes[n].in_graph && !placed.has(n))
    if (leftover.length) {
      const y = 28 + (Math.max(0, ...Object.values(pos).map(p => p.y)) - 28 + RANK_H) + RANK_H
      leftover.forEach((n, i) => { pos[n] = { x: 8 + i * (NODE_W + GAP_X), y } })
    }
    return pos
  }, [nodes])
}

// ─── tiny pieces ───────────────────────────────────────────────────
function colorFor(_name) {
  return 'var(--ui-accent)'
}

function Avatar({ name, node, size }) {
  const [enabled, setEnabled] = useState(!!node?.has_avatar)
  const av = useAvatar(name, enabled)
  useEffect(() => setEnabled(!!node?.has_avatar), [node?.has_avatar])

  if (enabled && av.data?.found) {
    return jsx('img', {
      src: av.data.data,
      alt: '',
      style: {
        width: size, height: size, flex: `0 0 ${size}px`,
        borderRadius: '22%', objectFit: 'cover', display: 'block'
      }
    })
  }

  const c = node?.color || colorFor(name)
  const clip = {
    circle: '50%', squircle: '30%', pill: '50% / 40%', triangle: '50% 50% 0 50%',
    hexagon: '28%', cloud: '50% 50% 42% 58%', drop: '50% 50% 50% 12%',
    blobatar: '42% 48% 45% 55% 44% 53% 47% 51%'
  }[node?.shape] || '30%'
  return jsx('span', {
    'aria-hidden': true,
    style: {
      width: size, height: size, flex: `0 0 ${size}px`,
      background: c,
      borderRadius: clip, display: 'inline-block',
      boxShadow: 'inset 0 -2px 4px color-mix(in srgb, var(--foreground) 22%, transparent)'
    }
  })
}

function Pill({ children, color }) {
  return jsx('span', {
    className: 'inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] text-(--ui-text-secondary)',
    style: color ? { border: `1px solid ${color}`, color }
               : { border: '1px solid var(--stroke)' },
    children
  })
}

// relative-age suffix for completed sessions: "3d", "2h", "just now"
function ageSuffix(lastActive) {
  if (!lastActive) return ''
  const s = Math.max(0, Date.now() / 1000 - lastActive)
  if (s < 90) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

// status → { label, color }: the freshness-aware lifecycle made visible.
// conversing = live turn; ready = answered; interrupted = abandoned >3min;
// idle = no session yet. Colors come from the token layer only.
function statusChipInfo(status, lastActive) {
  switch (status) {
    case 'active': return { label: 'conversing', color: 'var(--fg-accent)' }
    case 'complete': return { label: `ready${lastActive ? ' ' + ageSuffix(lastActive) : ''}`, color: 'var(--fg-success)' }
    case 'interrupted': return { label: 'interrupted', color: 'var(--fg-warning)' }
    default: return { label: 'idle', color: 'var(--fg-quaternary)' }
  }
}

function StatusChip({ status, lastActive }) {
  const info = statusChipInfo(status, lastActive)
  const isConversing = status === 'active'
  const isInterrupted = status === 'interrupted'
  return jsxs('span', {
    className: cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[0.625rem] font-medium transition-all',
      isConversing && 'fleet-chip-conversing',
      isInterrupted && 'fleet-chip-interrupted'),
    style: { borderColor: info.color, color: info.color },
    children: [
      jsx('span', { className: 'h-1.5 w-1.5 rounded-full', style: { background: info.color } }),
      isInterrupted && jsx('span', { className: 'text-[0.55rem]', children: '▲' }),
      info.label,
    ],
  })
}

function Select({ value, onChange, children, className }) {
  // Radix Select (SDK) composed over the plugin's native call shape:
  // options arrive as option-shaped jsx elements; we map them to SelectItem,
  // carrying the option's LABEL as the item's children (value alone would
  // render an empty row).
  // children may be a single element (jsx with one child) OR an array —
  // normalize before .filter, or single-child selects throw TypeError.
  const raw = Array.isArray(children) ? children : [children]
  const items = raw.filter(Boolean)
  return jsxs(SelectSdk, {
    value: value ?? '', onValueChange: v => onChange(v || null),
    children: [
      jsxs(SelectTrigger, { className: cn('h-7 text-xs', className), children: [
        jsx(SelectValue, {})
      ] }),
      jsx(SelectContent, {
        children: items.map(opt =>
          jsx(SelectItem, { value: opt.props.value, children: opt.props.children },
            opt.props.value ?? `opt-${items.indexOf(opt)}`))
      })
    ]
  })
}

function Field({ label, children }) {
  return jsxs('div', { className: 'mb-3', children: [
    jsx('div', { className: 'mb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-secondary)', children: label }),
    children
  ] })
}

/** Status ring color for activity tail */
function statusColor(status) {
  switch (status) {
    case 'active': return 'var(--fg-accent)'
    case 'interrupted': return 'var(--fg-danger)'
    case 'complete': return 'var(--fg-success)'
    case 'empty': return 'var(--fg-quaternary)'
    default: return 'var(--fg-warning)' // thinking / unknown
  }
}

// ─── SOUL editor ──────────────────────────────────────────────────
function SoulEditor({ name }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['fleet-soul', name],
    queryFn: () => api.rest(`/soul/${name}`),
  })
  const [text, setText] = useState(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => { if (q.data && text === null) setText(q.data.soul) }, [q.data])

  const save = useMutation({
    mutationFn: () => api.rest(`/soul/${name}`, { method: 'PUT', body: { soul: text } }),
    onSuccess: () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      qc.invalidateQueries({ queryKey: ['fleet-soul', name] })
      host.notify({ kind: 'success', message: `SOUL.md saved for ${name}` })
    },
    onError: e => host.notify({ kind: 'error', message: String(e?.message || e) })
  })

  if (q.isLoading) return jsx('div', { className: 'text-xs text-(--ui-text-secondary)', children: 'reading SOUL…' })
  if (text === null) return null
  const dirty = text !== q.data?.soul

  return jsxs('div', { children: [
    jsx('textarea', {
      value: text,
      onChange: e => setText(e.target.value),
      spellCheck: false,
      className: cn('h-48 w-full resize-y rounded-md border p-2 font-mono text-[0.6875rem] leading-relaxed',
        'border-(--ui-stroke-secondary) bg-transparent'),
      style: { color: 'var(--foreground)' }
    }),
    jsxs('div', { className: 'mt-1 flex items-center gap-2', children: [
      jsx('button', {
        type: 'button', disabled: !dirty || save.isPending,
        onClick: () => save.mutate(),
        className: cn('rounded-md px-2.5 py-1 text-xs font-medium text-(--color-primary-foreground)',
          'bg-(--ui-accent) disabled:opacity-40'),
        children: save.isPending ? 'saving…' : 'Save SOUL'
      }),
      saved && jsx('span', { className: 'text-xs', style: { color: 'var(--fg-success)' }, children: 'saved' }),
      jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: 'applies on the next session of this bot' })
    ] })
  ] })
}

// ─── Create profile — full-featured dialog mirroring Bots "New Agent" ──
function CreateProfile({ onDone, onClose, existingProfiles }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [supervisor, setSupervisor] = useState('')
  const [cloneFrom, setCloneFrom] = useState('')
  const [soul, setSoul] = useState('')
  const [modelChoice, setModelChoice] = useState('')
  const [modelFilter, setModelFilter] = useState('')
  const [showModel, setShowModel] = useState(false)
  const [skills, setSkills] = useState([])
  const [toolsets, setToolsets] = useState([])
  const [selectedSkills, setSelectedSkills] = useState(new Set())
  const [selectedToolsets, setSelectedToolsets] = useState(new Set())
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [selectedImports, setSelectedImports] = useState(new Set())

  // model options
  const modelQ = useQuery({
    queryKey: ['fleet-create-models'],
    queryFn: () => host.request('model.options', { include_unconfigured: true, explicit_only: false, refresh: true }),
    enabled: showAdvanced,
    staleTime: 60000,
  })
  const profilesQ = useQuery({
    queryKey: ['fleet-create-profiles'],
    queryFn: () => host.request('profiles.list', { include_sessions: false }),
    staleTime: 30000,
  })

  // discovered on-disk profiles not yet in the graph (issue #4). Explicit
  // import only: the backend never auto-scans at startup, so the YAML
  // stays the sole source of truth for graph structure.
  const discoverQ = useQuery({
    queryKey: ['fleet-profiles-discover'],
    queryFn: () => api.rest('/profiles/discover'),
    enabled: showImport,
    staleTime: 15000,
  })
  const discovered = discoverQ.data?.discovered || []
  const importMutation = useMutation({
    mutationFn: async () => {
      const res = await api.rest('/profiles/import', {
        method: 'POST',
        body: {
          profiles: [...selectedImports],
          supervisor: supervisor || undefined,
        },
      })
      return res
    },
    onSuccess: res => {
      qc.invalidateQueries({ queryKey: ['fleet-graph-overview'] })
      const n = (res.imported || []).length
      const skipped = (res.skipped || []).length
      host.notify({
        kind: 'success',
        message: `imported ${n} profile(s)${skipped ? `, skipped ${skipped} already wired` : ''}`
      })
      setSelectedImports(new Set())
      setShowImport(false)
      discoverQ.refetch()
    },
    onError: e => host.notify({ kind: 'error', message: `import failed: ${String(e?.message || e)}` })
  })
  const modelChoices = useMemo(() => {
    if (!modelQ.data?.providers) return []
    const flat = []
    for (const prov of modelQ.data.providers) {
      for (const m of prov.models || []) flat.push({ provider: prov.slug, model: m, label: `${prov.name}: ${m}` })
    }
    return flat
  }, [modelQ.data])

  // skills — describe the clone source's skill set
  const skillsQ = useQuery({
    queryKey: ['fleet-create-skills', cloneFrom],
    queryFn: () => host.request('profiles.describe', { name: cloneFrom }),
    enabled: !!cloneFrom,
    staleTime: 30000,
  })
  useEffect(() => {
    if (skillsQ.data) {
      setSkills(skillsQ.data.skills || [])
      setToolsets(skillsQ.data.toolsets || [])
      // default: keep all enabled
      setSelectedSkills(new Set((skillsQ.data.skills || []).filter(s => s.enabled).map(s => s.name)))
      setSelectedToolsets(new Set((skillsQ.data.toolsets || []).filter(t => t.enabled).map(t => t.name)))
    }
  }, [skillsQ.data])

  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const valid = /^[a-z0-9][a-z0-9-]{1,31}$/.test(slug)
  // Graph node names can be aliases; profile creation/cloning operates on the
  // canonical profile identity supplied by the backend.
  const graphNames = Array.isArray(existingProfiles)
    ? existingProfiles
    : Object.keys(existingProfiles || {})
  const profileNames = Array.isArray(existingProfiles)
    ? existingProfiles
    : Object.entries(existingProfiles || {}).map(([graphName, node]) => node?.profile || graphName)
  const inventoryProfiles = Array.isArray(profilesQ.data?.profiles)
    ? profilesQ.data.profiles
    : []
  const inventoryNames = inventoryProfiles
    .map(p => p?.name || p)
    .filter(name => typeof name === 'string' && PROFILE_ID_RE.test(name))
  const graphNamesForClone = profileNames
    .filter(name => typeof name === 'string' && PROFILE_ID_RE.test(name))
  const knownNames = useMemo(() => new Set([
    ...graphNamesForClone,
    ...inventoryNames,
  ]), [existingProfiles, profilesQ.data])
  const cloneProfiles = [...new Set([
    ...inventoryNames,
    ...graphNamesForClone,
  ])]
  // Any Hermes profile with the requested name is adopted rather than
  // recreated. Profiles that are not graph members can still be clone sources.
  const dupe = valid && knownNames.has(slug)
  const nameInvalid = name.trim().length > 0 && !valid
  const create = useMutation({
    mutationFn: async () => {
      const picked = modelChoice ? modelChoices.find(c => `${c.provider}\u0000${c.model}` === modelChoice) : undefined
      const capPayload = {}
      if (showAdvanced) {
        const disabled = (skills || []).filter(s => !selectedSkills.has(s.name)).map(s => s.name)
        if (disabled.length) capPayload.disabled_skills = disabled

        const enabledTs = [...selectedToolsets]
        if (enabledTs.length && enabledTs.length < (toolsets || []).length) {
          capPayload.enabled_toolsets = enabledTs
        }
      }

      // existing profile -> adopt it instead of failing on profiles.create
      if (!knownNames.has(slug)) {
        await host.request('profiles.create', {
          name: slug,
          description: description || (title ? `${title} — fleet member.` : ''),
          clone_from: cloneFrom || undefined,
          soul: soul || undefined,
          provider: picked?.provider,
          model: picked?.model,
        })

        // apply skill/toolset picks via profiles.configure (replace semantics)
        if (Object.keys(capPayload).length) {
          await host.request('profiles.configure', { name: slug, ...capPayload })
        }
      } else {
        const profilePayload = { name: slug }
        if (description.trim()) profilePayload.description = description.trim()
        if (soul.trim()) profilePayload.soul = soul
        if (picked) {
          profilePayload.provider = picked.provider
          profilePayload.model = picked.model
        }
        Object.assign(profilePayload, capPayload)
        if (Object.keys(profilePayload).length > 1) {
          await host.request('profiles.configure', profilePayload)
        }
      }

      // ALWAYS wire the new member into the chain — a profile with no graph
      // node sits in limbo and breaks later edits that reference it ("X is
      // not a known profile"). No supervisor picked = it joins as root.
      {
        const payload = {}
        for (const [n, v] of Object.entries(existingProfiles || {})) {
          payload[n] = { supervisor: v.supervisor ?? null, subordinates: v.subordinates ?? [] }
        }
        payload[slug] = { supervisor: supervisor || null, subordinates: [] }
        if (supervisor && payload[supervisor]) payload[supervisor].subordinates = [...new Set([...(payload[supervisor].subordinates || []), slug])]
        await api.rest('/graph', { method: 'PUT', body: { nodes: payload } })
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fleet-graph-overview'] })
      host.notify({ kind: 'success', message: knownNames.has(slug)
        ? `Profile "${slug}" adopted and wired into the chain`
        : `Profile "${slug}" created and wired in` })
      onDone()
    },
    onError: e => host.notify({ kind: 'error', message:
      `create failed: ${String(e?.message || e)} — if the profile dir already exists, Create will adopt it on retry` })
  })

  const allGraphNames = [...graphNames, slug].filter(Boolean)

  return jsxs(Dialog, {
    open: true, onOpenChange: o => { if (!o) onClose() },
    children: [
      jsxs(DialogContent, {
        className: cn('fleet-dialog fleet-dialog-panel',
          showAdvanced ? 'sm:max-w-3xl' : 'sm:max-w-md'),
        children: [
          jsxs(DialogHeader, { children: [
            jsx(DialogTitle, { children: 'New fleet member' }),
            jsx(DialogDescription, { children: 'creates the profile, wires it into the chain, and applies its persona + capabilities in one pass' })
          ] }),
        jsxs('div', { className: 'flex flex-col gap-3', children: [
          jsx(Input, {
            placeholder: 'profile name (any case — becomes a slug)',
            value: name, onChange: e => setName(e.target.value)
          }),
          jsx('div', { className: 'text-[0.625rem] text-(--ui-text-secondary)', children: 'becomes its handle everywhere — chat routing (/match), its node in the graph, and its profile folder' }),
          name.trim() && valid && jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: `will create profile "${slug}"` }),
          dupe && jsx('div', {
            className: 'text-xs font-medium text-(--fg-warning)',
            children: `a profile named "${slug}" already exists — Create will adopt it and wire it into the chain`
          }),
          nameInvalid && jsx('div', {
            className: 'text-xs font-medium text-(--fg-warning)',
            children: `name must produce a slug like "my-agent" (letters, digits, dashes) — currently "${slug || '—'}"`
          }),
          jsx(Input, {
            placeholder: 'display title (e.g. "Scout")',
            value: title, onChange: e => setTitle(e.target.value)
          }),
          jsx('div', { className: 'text-[0.625rem] text-(--ui-text-secondary)', children: 'short label shown on its card — not used for routing' }),
          jsx(Textarea, {
            className: 'h-16 resize-none text-xs',
            placeholder: 'role description',
            value: description, onChange: e => setDescription(e.target.value)
          }),
          jsx('div', { className: 'text-[0.625rem] text-(--ui-text-secondary)', children: 'what this member is for — other bots read it when deciding who to route work to' }),
          jsxs('div', { className: 'grid grid-cols-2 gap-2', children: [
            jsxs('label', { className: 'flex min-w-0 flex-col gap-1', children: [
              jsx('span', { className: 'text-[0.6875rem] font-medium text-(--ui-text-primary)', children: 'Supervisor (optional)' }),
              jsx(Select, {
                value: supervisor, onChange: setSupervisor, className: 'w-full',
                children: [
                  jsx('option', { value: '', children: 'No supervisor — make it a root' }, 'empty'),
                  ...allGraphNames.filter(p => p !== slug).map(p => jsx('option', { value: p, children: p }, p))
                ]
              }),
              jsx('span', { className: 'text-[0.625rem] leading-tight text-(--ui-text-secondary)', children: 'Who it reports to and where it sits in the fleet chain. Blank makes it a top-level member.' })
            ] }),
            jsxs('label', { className: 'flex min-w-0 flex-col gap-1', children: [
              jsx('span', { className: 'text-[0.6875rem] font-medium text-(--ui-text-primary)', children: 'Start from (optional)' }),
              jsx(Select, {
                value: cloneFrom, onChange: setCloneFrom, className: 'w-full',
                children: [
                  jsx('option', { value: '', children: 'Fresh profile' }, 'ph'),
                  ...cloneProfiles.map(p => jsx('option', { value: p, children: `Copy ${p}` }, p))
                ]
              }),
              jsx('span', { className: 'text-[0.625rem] leading-tight text-(--ui-text-secondary)', children: "Copies an existing member's starting persona, skills, and tools. Leave fresh to configure it yourself." })
            ] })
          ] }),
          jsx(Textarea, {
            className: 'h-20 resize-none font-mono text-[0.6875rem]',
            placeholder: 'SOUL.md (leave blank to auto-generate from name/title/description)',
            value: soul, onChange: e => setSoul(e.target.value)
          }),
          jsx('div', { className: 'text-[0.625rem] text-(--ui-text-secondary)', children: 'its personality + standing rules — written to its own SOUL.md; blank is fine, it gets generated from the name/title/description' }),
          jsx('label', {
            className: 'flex items-center gap-2 text-xs text-(--ui-text-secondary)',
            children: [
              jsx(Checkbox, {
                checked: showAdvanced,
                onCheckedChange: v => setShowAdvanced(!!v)
              }, 'advcb'),
              'Advanced: model + skills + toolsets'
            ]
          }, 'adv'),
          showAdvanced && jsx('div', { className: 'text-[0.625rem] text-(--ui-text-secondary)', children: 'all optional — a new member works fine inheriting defaults; set these only when it needs its own model or fewer tools' }),
          jsxs('div', { className: 'border-t border-(--ui-stroke-secondary) pt-3', children: [
            jsx(Button, {
              variant: 'outline',
              onClick: () => setShowImport(v => !v),
              children: showImport ? 'hide import' : 'import existing profiles'
            }),
            showImport && jsxs('div', { className: 'mt-2 flex flex-col gap-2', children: [
              discoverQ.isLoading
                ? jsx('div', { className: 'text-xs text-(--ui-text-secondary)', children: 'scanning profile directory…' })
                : discovered.length === 0
                  ? jsx('div', { className: 'text-xs text-(--ui-text-secondary)', children: 'no unwired on-disk profiles found: every profile is already in the graph' })
                  : discovered.map(d => {
                      const on = selectedImports.has(d.name)
                      return jsx('label', {
                        className: 'flex items-start gap-2 text-xs cursor-pointer',
                        children: [
                          jsx(Checkbox, {
                            checked: on,
                            onCheckedChange: v => {
                              const next = new Set(selectedImports)
                              v ? next.add(d.name) : next.delete(d.name)
                              setSelectedImports(next)
                            }
                          }, `imp-${d.name}`),
                          jsxs('span', { children: [
                            jsx('div', { className: 'font-medium', children: d.name }),
                            (d.title || d.description) && jsx('div', {
                              className: 'text-[0.65rem] text-(--ui-text-secondary)',
                              children: [d.title, d.description].filter(Boolean).join(' - ')
                            })
                          ] })
                        ]
                      }, `impwrap-${d.name}`)
                    }),
              discovered.length > 0 && jsx('div', { className: 'flex items-center gap-2', children:
                jsx(Button, {
                  disabled: selectedImports.size === 0 || importMutation.isPending,
                  onClick: () => importMutation.mutate(),
                  children: importMutation.isPending
                    ? 'importing…'
                    : `wire ${selectedImports.size} profile(s) into the graph`
                })
              })
            ] })
          ] }, 'impsec'),
        ] }),
        showAdvanced && jsxs('div', { className: 'mt-3 grid gap-3 border-t border-(--ui-stroke-secondary) pt-3', children: [
          // Model section
          jsx('div', { children: jsxs('div', { className: 'flex flex-col gap-1', children: [
            jsxs('div', { className: 'flex gap-2', children: [
            jsx(Input, {
              className: 'flex-1 h-7 text-xs',
              placeholder: 'filter models…',
              value: modelFilter,
              onChange: e => setModelFilter(e.target.value)
            }),
            jsx(Select, {
              value: modelChoice,
              onChange: v => setModelChoice(v || ''),
              className: 'flex-1',
              children: [
                jsx('option', { value: '', children: 'inherit from launch profile' }, 'inherit'),
                ...modelChoices.filter(c => c.label.toLowerCase().includes(modelFilter.toLowerCase())).map(c =>
                  jsx('option', { value: `${c.provider}\u0000${c.model}`, children: c.label }, `${c.provider}\u0000${c.model}`)
                )
              ]
            })
          ] }),
          jsx('div', { className: 'text-[0.625rem] text-(--ui-text-secondary)', children: 'the LLM this member runs on — leave on inherit unless it needs a different model than yours' }),
          ] }) }),
          // Skills section
          skills.length > 0 && jsxs('div', { children: [
            jsx('div', { className: 'flex flex-wrap gap-1', children: skills.map(s => {
            const on = selectedSkills.has(s.name)
            return jsx('label', {
              className: 'flex items-center gap-1 text-xs',
              children: [
                jsx(Checkbox, { checked: on,
                  onCheckedChange: v => {
                    const next = new Set(selectedSkills)
                    v ? next.add(s.name) : next.delete(s.name)
                    setSelectedSkills(next)
                  }
                }),
                jsx('span', { className: 'truncate', children: s.name }),
                s.tool_count ? jsx('span', { className: 'text-[0.6rem] text-(--ui-text-secondary)', children: `${s.tool_count}` }) : null
              ]
            }, s.name)
          }) }),
          jsx('div', { className: 'text-[0.625rem] text-(--ui-text-secondary)', children: 'untick skills this member should NOT have — each bundles a set of commands it can run' }),
          ] }),
          // Toolsets section
          toolsets.length > 0 && jsxs('div', { children: [
            jsx('div', { className: 'flex flex-wrap gap-1', children: toolsets.map(t => {
            const on = selectedToolsets.has(t.name)
            return jsx('label', {
              className: 'flex items-center gap-1 text-xs',
              children: [
                jsx(Checkbox, { checked: on,
                  onCheckedChange: v => {
                    const next = new Set(selectedToolsets)
                    v ? next.add(t.name) : next.delete(t.name)
                    setSelectedToolsets(next)
                  }
                }),
                jsx('span', { className: 'truncate', children: t.name }),
                t.tool_count ? jsx('span', { className: 'text-[0.6rem] text-(--ui-text-secondary)', children: `${t.tool_count}` }) : null
              ]
            }, t.name)
          }) }),
          jsx('div', { className: 'text-[0.625rem] text-(--ui-text-secondary)', children: 'raw tool families it may call (terminal, web, files…) — fewer = narrower blast radius; only applies when you untick at least one' }),
          ] }),
        ] }),
        jsxs(DialogFooter, { children: [
          jsx(Button, {
            variant: 'outline', onClick: onClose,
            children: 'Cancel'
          }),
          jsx(Button, {
            disabled: !valid || create.isPending,
            onClick: () => create.mutate(),
            children: create.isPending ? 'working…' : (dupe ? 'Adopt & wire in' : 'Create')
          })
        ] })
        ]
      })
    ]
  })
}

// ─── bot card (command deck v2) ─────────────────────────────────────
// FLUSH full-width card. Hierarchy lives in SECTION HEADERS, never in pixel
// indents — indents on wide cards read as random misalignment. Every card
// carries an identical right rail: [inbox cell][status chip]. The inbox cell
// is ALWAYS present: accent "N new" = unread, dim ✓N = read, invisible = none.
function BotCard({ name, node, selected, onSelect, onMarkRead, talking, rosterCap }) {
  const open = selected === name
  const displayName = node.title || name
  const ls = node.latest_session
  const chip = statusChipInfo(ls?.status, ls?.last_active)

  const cap = rosterCap?.summary || node.description || ''
  const roleLine = cap ? cap.slice(0, 90) + (cap.length > 90 ? '…' : '')
                       : (node.title ? `${name} · ${node.title}` : name)

  return jsxs('button', {
    type: 'button',
    onClick: () => onSelect(open ? null : name),
    title: cap || undefined,
    className: cn('group relative flex w-full items-center gap-3 overflow-hidden rounded-lg px-3 py-2 mb-1.5 text-left transition-all',
      open ? 'bg-(--chrome-action-hover) border border-(--stroke-accent) shadow-[inset_0_0_0_1px_var(--stroke-accent)]'
           : 'border border-(--ui-stroke-secondary)/50 hover:bg-(--chrome-action-hover)/60 hover:border-(--ui-stroke-secondary)',
      talking && 'fleet-node-talking'),
    children: [
      jsx('span', {
        'aria-hidden': true,
        className: 'absolute inset-y-0 left-0 w-[2px]',
        style: { background: chip.color, opacity: talking ? 1 : 0.6 },
      }),
      jsx(Avatar, { name, node, size: 34 }),
      jsxs('span', { className: 'min-w-0 flex-1', children: [
        jsxs('span', { className: 'flex items-baseline gap-2', children: [
          jsx('span', { className: 'truncate text-sm font-semibold tracking-[-0.01em]', children: displayName }),
          jsx('span', { className: 'shrink-0 truncate font-mono text-[0.625rem] font-normal text-(--ui-text-secondary)', children: name }),
        ] }),
        jsx('span', { className: 'mt-px block truncate text-[0.6875rem] leading-4 text-(--fg-secondary)', children: roleLine }),
      ] }),
      // inbox cell
      node.unread ? jsx('button', {
        type: 'button',
        onClick: e => { e.stopPropagation(); onMarkRead(name) },
        title: `Mark ${node.unread} read`,
        className: 'fleet-badge-new shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-bold text-(--color-primary-foreground) shadow-sm transition-transform group-hover:scale-105',
        style: { background: 'var(--fg-accent)' },
        children: `${node.unread} new`
      }) : jsx('span', {
        className: 'shrink-0 w-[3px]',
        'aria-hidden': true,
      }),
      jsx(StatusChip, { status: ls?.status, lastActive: ls?.last_active }),
    ],
  })
}


// ─── message composer (deck → bot → its connections) ───────────────
// Lets the operator open a framed conversation with a bot: talk (peers),
// delegate (downward), supervisor (upward). The backend validates the edge;
// the receiving bot resolves the frame via the initiative ladder.
function MessageComposer({ name, node, relations }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState('talk')
  const [text, setText] = useState('')
  const [result, setResult] = useState(null)
  const send = useMutation({
    mutationFn: body => api.rest('/send', { method: 'POST', body }),
    onSuccess: r => {
      setResult({ ok: true, ...r })
      setText('')
      qc.invalidateQueries({ queryKey: ['fleet-inbox', name] })
      qc.invalidateQueries({ queryKey: ['fleet-graph-overview'] })
      qc.invalidateQueries({ queryKey: ['fleet-traffic'] })
    },
    onError: e => setResult({ ok: false, error: String(e?.message || e) }),
  })

  const peers = relations?.peers || []
  const sup = relations?.supervisor || null

  // reachable targets per frame. The recipient is resolved server-side from
  // the frame + live graph (the client never names it), so these lists only
  // drive the reachability hint + the single-target display:
  //   talk       -> one of `name`'s peers          (backend: name -> peers[0])
  //   delegate   -> `name` itself                  (backend: orchestrator -> name;
  //                  the receiving bot splits work downward on its own)
  //   supervisor -> `name`'s supervisor            (backend: name -> supervisor)
  const targets = kind === 'talk' ? peers
    : kind === 'delegate' ? [name]
    : sup ? [sup] : []
  const [target, setTarget] = useState('')
  const effectiveTarget = targets.length === 1 ? targets[0]
    : (targets.includes(target) ? target : '')
  const canSend = text.trim().length > 0 && (targets.length === 0 ? false : !!effectiveTarget) && !send.isPending
  const deliveryLabel = result?.delivery?.state === 'queued' ? 'queued'
    : result?.delivery?.state === 'failed' ? 'inbox recorded; live start failed'
    : 'recorded'

  return jsxs('div', { className: 'flex flex-col gap-2.5', children: [
    jsx('div', { className: 'text-[0.6875rem] leading-4 text-(--ui-text-secondary)', children:
      `Start a framed conversation with ${node?.title || name}. The recipient's Bot Chat turn is queued now, and the inbox keeps a durable copy.` }),
    // frame picker
    jsxs('div', { className: 'flex flex-col gap-1', children: [
      jsx('div', { className: 'text-[0.625rem] font-medium uppercase tracking-wide text-(--ui-text-secondary)', children: 'frame' }),
      jsx(Select, {
        value: kind, onChange: v => { setKind(v); setTarget('') }, className: 'w-full',
        children: [
          jsx('option', { value: 'talk', children: `talk — coordinate with a peer of ${name}` }, 'talk'),
          jsx('option', { value: 'delegate', children: `delegate — hand work down to ${name}` }, 'delegate'),
          jsx('option', { value: 'supervisor', children: `${name} escalates upward` }, 'supervisor'),
        ]
      }),
    ] }),
    // target
    jsxs('div', { className: 'flex flex-col gap-1', children: [
      jsx('div', { className: 'text-[0.625rem] font-medium uppercase tracking-wide text-(--ui-text-secondary)', children: 'recipient' }),
      targets.length === 0
        ? jsx('div', { className: 'text-xs text-(--fg-warning)', children:
            kind === 'talk' ? `${name} has no peer relations — add one in Configure first`
            : kind === 'delegate' ? `${name} has no subordinates to receive work`
            : 'no supervisor available' })
        : targets.length === 1
          ? jsx('div', { className: 'text-xs font-medium text-(--ui-text-secondary)', children: `→ ${effectiveTarget}` })
          : jsx(Select, { value: target, onChange: setTarget, className: 'w-full', children: [
              jsx('option', { value: '', children: 'pick recipient…' }, 'ph'),
              ...targets.map(t => jsx('option', { value: t, children: t }, t)),
            ] }),
    ] }),
    // text
    jsx(Textarea, {
      className: 'h-24 resize-none text-xs font-mono',
      placeholder: 'message — specific instructions are queued into Bot Chat; inbox copy retained',
      value: text, onChange: e => setText(e.target.value),
    }),
    jsx(Button, {
      disabled: !canSend,
      // recipient rides along for the talk frame only (validated server-side
      // against the peer list); delegate/supervisor resolve it from the graph.
      onClick: () => send.mutate({ to: name, kind, live: true, text: text.trim(), ...(kind === 'talk' && effectiveTarget ? { recipient: effectiveTarget } : {}) }),
      children: send.isPending ? 'starting…' : 'Start conversation'
    }),
    result && jsx('div', {
      className: cn('rounded-md border p-2 text-[0.6875rem] leading-4',
        result.ok && result.delivery?.state !== 'failed' ? 'border-(--fg-success)/40 text-(--ui-text-secondary)' : 'border-(--fg-danger)/50 text-(--fg-danger)'),
      children: result.ok
        ? `${deliveryLabel} → ${result.recipient} (frame: ${result.frame}, edge: ${result.edge})`
        : result.error,
    }),
  ] })
}

// ─── canvas node (rich: avatar + label + status + unread) ──────────
function useAvatarData(name, enabled) {
  const q = useQuery({
    queryKey: ['fleet-avatar-data', name],
    queryFn: () => api.rest(`/avatar/${name}`),
    enabled: !!enabled,
    staleTime: 5 * 60 * 1000,
  })
  return q.data?.found ? q.data.data : null
}

const NODE_W = 200
const NODE_H = 56

function CanvasNode({ name, node, p, live, selected, onOpen }) {
  const hasAv = !!node.has_avatar
  const av = useAvatarData(name, hasAv)
  const clipId = 'avclip-' + name.replace(/[^a-z0-9]/gi, '')
  const st = node.latest_session?.status
  const unread = node.unread || 0
  const isSel = selected === name

  return jsxs('g', {
    transform: `translate(${p.x},${p.y})`,
    onClick: () => onOpen(name),
    style: { cursor: 'pointer' },
    children: [
      // card — quiet surface, single hairline; state carried by the left bar,
      // not by competing strokes (Astryx: calm containers, signal in one place)
      jsx('rect', {
        x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 10, ry: 10,
        className: 'fleet-node-card',
        fill: 'var(--surface-card)',
        stroke: isSel ? 'var(--stroke-accent)' : 'var(--stroke)',
        strokeWidth: isSel ? 1.5 : 1,
      }),
      // status accent bar (left edge) — replaces the corner dot
      jsx('rect', {
        x: 0, y: 8, width: 3, height: NODE_H - 16,
        rx: 1.5, ry: 1.5,
        fill: st ? statusColor(st) : 'var(--stroke)',
        opacity: live ? 1 : 0.85,
      }),
      // avatar disc
      jsx('circle', { cx: 30, cy: NODE_H / 2, r: 16, fill: node.color || colorFor(name) }),
      av && jsxs(Fragment, { children: [
        jsx('clipPath', { id: clipId, children: jsx('circle', { cx: 30, cy: NODE_H / 2, r: 15 }) }),
        jsx('image', {
          href: av, x: 15, y: NODE_H / 2 - 15, width: 30, height: 30,
          clipPath: `url(#${clipId})`, preserveAspectRatio: 'xMidYMid slice',
        }),
      ] }),
      !av && jsx('text', {
        x: 30, y: NODE_H / 2 + 5, textAnchor: 'middle', fontSize: 14, fontWeight: 700,
        fill: 'var(--color-primary-foreground)', style: { pointerEvents: 'none', userSelect: 'none' },
        children: (node.title || name).slice(0, 1).toUpperCase(),
      }),
      // name + role — title case name, slug below in quaternary
      jsx('text', {
        x: 54, y: 23, fontSize: 13, fontWeight: 600,
        className: 'fleet-node-label-halo',
        fill: 'var(--fg-primary)', style: { pointerEvents: 'none', userSelect: 'none' },
        children: (node.title || name).slice(0, 17),
      }),
      jsx('text', {
        x: 54, y: 40, fontSize: 9.5,
        className: 'fleet-node-label-halo',
        fill: 'var(--fg-quaternary)', style: { pointerEvents: 'none', userSelect: 'none' },
        children: (live ? '● discussing' : st === 'complete' ? 'ready' : st === 'active' ? 'conversing' : st === 'interrupted' ? 'interrupted' : (st ? String(st) : 'idle')).slice(0, 24),
      }),
      // unread badge — top-right corner chip, overlaps card edge slightly
      unread > 0 && jsxs(Fragment, { children: [
        jsx('circle', {
          cx: NODE_W - 2, cy: 2, r: 10,
          fill: 'var(--fg-accent)',
          stroke: 'var(--surface-card)', strokeWidth: 2,
        }),
        jsx('text', {
          x: NODE_W - 2, y: 6, textAnchor: 'middle', fontSize: 10, fontWeight: 700,
          fill: 'var(--color-primary-foreground)', style: { pointerEvents: 'none', userSelect: 'none' },
          children: unread > 9 ? '9+' : String(unread),
        }),
      ] }),
      // live pulse ring — only while actively working
      live && jsx('circle', {
        cx: NODE_W - 14, cy: NODE_H - 14, r: 4,
        fill: 'none', stroke: 'var(--fg-accent)', strokeWidth: 1.5, opacity: 0.7,
      }),
    ],
  })
}

// ─── activity tail drawer (the live transcript) ────────────────────
// ─── Inspector drawer (shared by Tree + Canvas) ───────────────────
// One slide-over per selected bot. Live = 4s-polling transcript (the old
// ActivityTail body). Inbox = fleet messages + mark-all-read. Configure =
// the rewire editors that used to live inline in every tree row.
function Inspector({ name, node, tab, setTab, onClose, onMarkRead,
                     draft, setDraft, profiles, rosterCap, docked,
                     hasUnsavedChanges }) {
  const qc = useQueryClient()
  const [removeArmed, setRemoveArmed] = useState(false)
  // transcript query — same shape as ActivityTail used
  const q = useQuery({
    queryKey: ['fleet-tail-msgs', name],
    queryFn: () => api.rest(`/sessions/${name}/messages?limit=40`),
    refetchInterval: 4000,
  })
  const inbox = useInbox(name, true)
  const msgs = inbox.data?.messages || []
  const scrollRef = useRef(null)
  const transcriptSignature = (q.data?.messages || [])
    .map((m, i) => `${m.id ?? `${m.ts ?? 'message'}-${i}`}:${String(m.text || '').length}`)
    .join('\u0000')
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [transcriptSignature])
  const ls = node?.latest_session

  // ── configure editors (moved verbatim from old BotRow) ──
  const setSup = (sup) => setDraft(d => {
    const next = structuredClone(d)
    next[name] = next[name] || { supervisor: null, subordinates: [] }
    const old = next[name].supervisor
    if (old && next[old]) next[old].subordinates = (next[old].subordinates || []).filter(s => s !== name)
    next[name].supervisor = sup
    if (sup) {
      next[sup] = next[sup] || { supervisor: null, subordinates: [] }
      next[sup].subordinates = [...new Set([...(next[sup].subordinates || []), name])]
    }
    return next
  })
  const detach = (sub) => setDraft(d => {
    const next = structuredClone(d)
    next[name].subordinates = (next[name].subordinates || []).filter(s => s !== sub)
    if (next[sub]) next[sub].supervisor = null
    return next
  })
  const togglePeer = (peer) => setDraft(d => {
    const next = structuredClone(d)
    const mine = new Set(next[name]?.peers || [])
    const theirs = new Set(next[peer]?.peers || [])
    if (mine.has(peer)) { mine.delete(peer); theirs.delete(name) }
    else { mine.add(peer); theirs.add(name) }
    next[name] = { ...(next[name] || {}), peers: [...mine].sort() }
    next[peer] = { ...(next[peer] || {}), peers: [...theirs].sort() }
    return next
  })
  const attach = (sub) => setDraft(d => {
    const next = structuredClone(d)
    const old = next[sub]?.supervisor
    if (old && next[old]) next[old].subordinates = (next[old].subordinates || []).filter(s => s !== sub)
    next[sub] = next[sub] || { supervisor: null, subordinates: [] }
    next[sub].supervisor = name
    next[name].subordinates = [...new Set([...(next[name].subordinates || []), sub])]
    return next
  })
  const peerCandidates = profiles.filter(p =>
    p !== name &&
    !(draft[name]?.peers || []).includes(p) &&
    (draft[p]?.supervisor || null) !== name &&
    (draft[name]?.supervisor || null) !== p
  )

  const currentNode = draft[name] || node || {}
  const directReports = currentNode.subordinates || []
  const removeFromHierarchy = useMutation({
    mutationFn: () => {
      const parent = currentNode.supervisor || null
      const nodes = {}
      if (parent) {
        nodes[parent] = {
          subordinates: (draft[parent]?.subordinates || []).filter(s => s !== name),
        }
      }
      const relations = {}
      for (const profile of profiles) {
        if (profile === name) continue
        const peers = (draft[profile]?.peers || []).filter(p => p !== name)
        if (peers.length) relations[profile] = peers
      }
      return api.rest('/graph', {
        method: 'PUT',
        body: { nodes, relations, remove: [name] },
      })
    },
    onSuccess: () => {
      setRemoveArmed(false)
      qc.invalidateQueries({ queryKey: ['fleet-graph-overview'] })
      onClose()
      host.notify({ kind: 'success', message: `Removed ${name} from the hierarchy; profile retained` })
    },
    onError: e => {
      setRemoveArmed(false)
      host.notify({ kind: 'error', message: String(e?.message || e) })
    },
  })

  const tabs = [['live', 'Live'], ['inbox', node.unread ? `Inbox (${node.unread})` : 'Inbox'],
                ['message', 'Message'], ['configure', 'Configure'], ['soul', 'SOUL']]

  // relations snapshot for the message composer (who can this bot reach)
  const draftRelations = (n) => ({
    supervisor: draft[n]?.supervisor ?? node?.supervisor ?? null,
    subordinates: draft[n]?.subordinates ?? node?.subordinates ?? [],
    peers: draft[n]?.peers ?? node?.peers ?? [],
  })

  return jsxs('div', {
    className: cn('fleet-tail flex h-full w-full flex-col',
      // slide-over when floating on canvas; static panel when docked in the deck
      !docked && 'absolute inset-y-0 right-0 z-20 w-[24rem] max-w-[90%] border-l border-(--ui-stroke-secondary)'),
    style: { background: 'var(--background)' },
    children: [
      // header
      jsxs('div', { className: 'flex items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2.5', children: [
        jsx(Avatar, { name, node, size: 28 }),
        jsxs('div', { className: 'min-w-0 flex-1', children: [
          jsx('div', { className: 'truncate text-sm font-semibold', children: node?.title || name }),
          jsx(StatusChip, {
            status: ls?.status, lastActive: ls?.last_active,
          }),
        ] }),
        jsx('button', {
          type: 'button', onClick: onClose,
          className: 'rounded-md border border-(--ui-stroke-secondary) px-2 py-0.5 text-xs hover:bg-(--chrome-action-hover)',
          children: '✕'
        }),
      ] }),
      // tab strip
      jsx('div', { className: 'flex gap-1 border-b border-(--ui-stroke-secondary) px-3 py-1.5',
        children: tabs.map(([k, label]) => jsx('button', {
          type: 'button', onClick: () => setTab(k),
          className: cn('rounded px-2 py-0.5 text-[0.6875rem] transition-colors',
            tab === k ? 'bg-(--chrome-action-hover) font-medium' : 'text-(--ui-text-secondary) hover:text-(--ui-text-secondary)'),
          children: label
        }, k))
      }),
      jsxs('div', { ref: scrollRef, className: 'min-h-0 flex-1 overflow-auto p-3', children: [
        tab === 'live' && jsxs(Fragment, { children: [
          q.isLoading && jsx('div', { className: 'text-xs text-(--ui-text-secondary)', children: 'reading transcript…' }),
          !q.isLoading && (q.data?.messages || []).length === 0 &&
            jsx('div', { className: 'text-xs text-(--ui-text-secondary)', children: 'no messages in the latest session' }),
          ...((q.data?.messages || []).map((m, i) => jsxs('div', {
            className: cn('mb-2 rounded-lg border px-2.5 py-1.5',
              m.role === 'user' ? 'border-(--ui-stroke-secondary)' : 'border-(--ui-accent)/40'),
            children: [
              jsx('div', { className: 'mb-0.5 text-[0.625rem] font-semibold uppercase tracking-wide',
                style: { color: m.role === 'user' ? 'var(--fg-quaternary)' : 'var(--fg-accent)' },
                children: m.role === 'user' ? 'you' : name }),
              jsx('div', { className: 'whitespace-pre-wrap break-words text-xs leading-relaxed',
                style: { color: 'var(--foreground)' },
                children: m.text }),
            ]
          }, m.id ?? `${m.ts ?? 'message'}-${i}`))),
          rosterCap?.summary && jsx('div', {
            className: 'mt-3 rounded-lg border border-dashed border-(--ui-stroke-secondary) p-2 text-[0.6875rem] text-(--ui-text-secondary)',
            children: `specialist for: ${rosterCap.summary}` }),
        ] }),
        tab === 'inbox' && jsxs(Fragment, { children: [
          msgs.length > 0 && jsx('button', {
            type: 'button',
            onClick: () => onMarkRead(name),
            className: 'mb-2 self-start rounded-md border border-(--ui-stroke-secondary) px-2 py-1 text-[0.6875rem] hover:bg-(--chrome-action-hover)',
            children: 'Mark all read'
          }),
          msgs.length === 0 && jsx('div', { className: 'text-xs text-(--ui-text-secondary)', children: 'inbox empty' }),
          msgs.slice().reverse().map((m, i) => jsxs('div', {
            className: 'mb-1 rounded-md border border-(--ui-stroke-secondary) p-1.5 text-[0.6875rem]',
            children: [
              jsxs('span', { className: 'font-medium', children: [m.sender || m.from, ' · ', m.type] }),
              m.task ? jsxs('span', { className: 'text-(--ui-text-secondary)', children: [' · ', m.task] }) : null,
              m.summary && jsx('div', { className: 'mt-0.5 text-(--ui-text-secondary)', children: m.summary }),
            ]
          }, m.id ?? `${m.ts ?? 'inbox'}-${i}`)),
        ] }),
        tab === 'configure' && jsxs(Fragment, { children: [
          node.description && jsx('div', { className: 'mb-2 text-xs text-(--ui-text-secondary)', children: node.description }),
          jsxs('div', { className: 'mb-3 flex flex-wrap gap-1.5', children: [
            !draft[name]?.supervisor && !node.supervisor ? jsx(Pill, { children: 'ROOT — reports to you' })
              : jsx(Pill, { children: `reports to ${node.supervisor}` }),
            node.model ? jsx(Pill, { children: `${node.provider || '?'} / ${node.model}` }) : null,
            jsx(Pill, { children: `${(node.subordinates || []).length} report${(node.subordinates || []).length === 1 ? '' : 's'}` }),
            !node.in_graph && jsx(Pill, { children: 'not in graph yet' }),
          ] }),
          jsx(Field, { label: 'supervisor', children: jsx(Select, {
            value: draft[name]?.supervisor,
            onChange: v => setSup(v),
            className: 'w-full max-w-60',
            children: [
              jsx('option', { value: '', children: '— none (root) —' }, 'empty'),
              ...profiles.filter(p => p !== name).map(p => jsx('option', { value: p, children: p }, p)),
            ]
          }) }),
          jsx(Field, { label: 'reports', children: jsxs('div', { className: 'flex flex-wrap items-center gap-1', children: [
            (draft[name]?.subordinates || []).length === 0 &&
              jsx('span', { className: 'text-xs text-(--ui-text-secondary)', children: 'no direct reports' }),
            (draft[name]?.subordinates || []).map(sub => jsx('button', {
              type: 'button',
              title: 'click to detach',
              onClick: () => detach(sub),
              className: 'inline-flex items-center gap-1 rounded-full border border-(--ui-accent) px-2 py-0.5 text-[0.6875rem] text-(--ui-accent) hover:line-through',
              children: sub
            }, sub)),
            jsx(Select, {
              value: '', className: 'h-5 w-28 rounded-full px-1 text-[0.6875rem]',
              onChange: v => v && attach(v),
              children: [
                jsx('option', { value: '', children: '+ add report' }, 'ph'),
                ...profiles
                  .filter(p => p !== name && (draft[p]?.supervisor || null) !== name)
                  .map(p => jsx('option', { value: p, children: p }, p)),
              ]
            }),
          ] }) }),
          jsxs('div', { className: 'mt-4 rounded-md border border-(--ui-stroke-secondary) p-2.5', children: [
            jsx('div', { className: 'text-[0.625rem] font-semibold uppercase tracking-wide text-(--ui-text-secondary)', children: 'hierarchy membership' }),
            directReports.length > 0
              ? jsx('div', { className: 'mt-1 text-[0.6875rem] leading-4 text-(--ui-text-secondary)', children: 'Move or detach this member’s reports first. A node with reports cannot be removed safely.' })
              : hasUnsavedChanges
                ? jsx('div', { className: 'mt-1 text-[0.6875rem] leading-4 text-(--ui-text-secondary)', children: 'Save or discard the current wiring changes before removing this member.' })
                : jsxs('div', { className: 'mt-1 flex items-center gap-2', children: [
                    jsx('button', {
                      type: 'button',
                      disabled: removeFromHierarchy.isPending,
                      onClick: () => {
                        if (!removeArmed) { setRemoveArmed(true); return }
                        removeFromHierarchy.mutate()
                      },
                      className: 'rounded-md border border-(--fg-danger)/60 px-2.5 py-1 text-[0.6875rem] font-medium text-(--fg-danger) hover:bg-(--fg-danger)/10 disabled:opacity-40',
                      children: removeFromHierarchy.isPending
                        ? 'removing…'
                        : (removeArmed ? 'click again to confirm' : 'remove from hierarchy'),
                    }),
                    jsx('span', { className: 'text-[0.625rem] leading-4 text-(--ui-text-secondary)', children: 'keeps the profile folder; you can import it again later' }),
                  ] }),
          ] }),
          jsx(Field, { label: 'co-workers (peer relations — may message each other directly)', children: jsxs('div', { className: 'flex flex-wrap items-center gap-1', children: [
            (draft[name]?.peers || []).length === 0 &&
              jsx('span', { className: 'text-xs text-(--ui-text-secondary)', children: 'no peer relations' }),
            (draft[name]?.peers || []).map(peer => jsx('button', {
              type: 'button',
              title: 'click to remove the peer relation (both sides)',
              onClick: () => togglePeer(peer),
              className: 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] hover:line-through',
              style: { borderColor: 'var(--fg-success)', color: 'var(--fg-success)' },
              children: peer
            }, peer)),
            jsx(Select, {
              value: '', className: 'h-5 w-32 rounded-full px-1 text-[0.6875rem]',
              onChange: v => v && togglePeer(v),
              children: [
                jsx('option', { value: '', children: '+ add co-worker' }, 'ph'),
                ...peerCandidates.map(p => jsx('option', { value: p, children: p }, p)),
              ]
            }),
          ] }) }),
        ] }),
        tab === 'message' && jsx(MessageComposer, { name, node, relations: draftRelations(name) }),
        tab === 'soul' && jsx(SoulEditor, { name: node.profile || name }),
      ] }),
      jsx('div', { className: 'border-t border-(--ui-stroke-secondary) px-3 py-1.5 text-[0.625rem] text-(--ui-text-secondary)', children:
        tab === 'live'
          ? (q.isError ? 'reconnecting… (showing last known transcript)' : 'live · refreshes every 4s while open')
          : (tab === 'configure' ? 'edits join the draft — save from the bottom bar' : '') }),
    ],
  })
}

// ─── Canvas Graph view ────────────────────────────────────────────
// Renders an SVG of the topology. Nodes are clickable; edges draw supervisor/
// parent→child and peer (dashed) relations. A live activity pulse animates
// nodes whose gateway event stream is active.
function CanvasGraph({ nodes, draft, setDraft, profiles, selected, onSelect,
                        onMarkRead, liveProfiles, trafficIdx }) {
  const q = useOverview()
  // The Deck and Graph share the same editable draft. A server refetch is
  // still useful for runtime badges, but it must not hide an unsaved Deck
  // rewire from the canvas.
  const data = mergeNodesWithDraft(q.data?.nodes || nodes, draft)
  const pos = useLayout(data)
  const svgW = Math.max(720, Math.max(0, ...Object.entries(pos).map(([_, p]) => p.x)) + 220)
  const svgH = Math.max(400, Math.max(0, ...Object.entries(pos).map(([_, p]) => p.y)) + 100)

  // ── viewport: pan (drag empty space) + zoom (wheel), persisted ──
  const [vp, setVp] = useState({ tx: 0, ty: 0, scale: 1 })
  const [viewportReady, setViewportReady] = useState(false)
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 })
  const vpRef = useRef(vp)
  const frameRef = useRef(null)
  const fittedRef = useRef(false)
  vpRef.current = vp
  const dragRef = useRef(null) // {sx, sy, tx, ty} while panning

  const fittedViewport = (width, height) => {
    if (!(width > 0 && height > 0 && svgW > 0 && svgH > 0)) return null
    const pad = 28
    const scale = Math.min(1, Math.max(0.4,
      Math.min((width - pad * 2) / svgW, (height - pad * 2) / svgH)))
    return {
      scale,
      tx: (width - svgW * scale) / 2,
      ty: (height - svgH * scale) / 2,
    }
  }
  const fitViewport = () => {
    const rect = frameRef.current?.getBoundingClientRect?.()
    const next = fittedViewport(rect?.width || frameSize.width, rect?.height || frameSize.height)
    if (!next) return
    fittedRef.current = true
    setVp(next)
    setViewportReady(true)
  }

  // Restore before persistence is enabled. The previous ordering wrote the
  // default viewport over a valid stored value during the mount pass.
  useEffect(() => {
    if (!api?.storage) return
    const raw = api.storage.get('canvas-view')
    if (!raw) return
    try {
      const v = JSON.parse(raw)
      if (typeof v.tx === 'number' && typeof v.ty === 'number' &&
          v.scale >= 0.4 && v.scale <= 2) {
        fittedRef.current = true
        setVp(v)
        setViewportReady(true)
      }
    } catch {}
  }, [])

  // Track the live pane, then fit a fresh canvas once. Persisted/operator
  // viewports always win; the Fit control can deliberately recalculate later.
  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      const width = Math.max(0, rect.width)
      const height = Math.max(0, rect.height)
      setFrameSize(old => old.width === width && old.height === height ? old : { width, height })
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(el)
      return () => observer.disconnect()
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
  }, [])
  useEffect(() => {
    if (fittedRef.current) return
    const next = fittedViewport(frameSize.width, frameSize.height)
    if (!next) return
    fittedRef.current = true
    setVp(next)
    setViewportReady(true)
  }, [frameSize.width, frameSize.height, svgW, svgH])
  useEffect(() => {
    if (!viewportReady || !api?.storage) return
    try { api.storage.set('canvas-view', JSON.stringify(vp)) } catch {}
  }, [vp, viewportReady])

  const onWheel = (e) => {
    e.preventDefault()
    const old = vpRef.current
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const next = Math.min(2, Math.max(0.4, old.scale * factor))
    if (next === old.scale) return
    // zoom around the cursor position within the container
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setVp({
      scale: next,
      tx: mx - ((mx - old.tx) * next) / old.scale,
      ty: my - ((my - old.ty) * next) / old.scale,
    })
  }

  const onMouseDownBg = (e) => {
    if (e.button !== 0) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, tx: vpRef.current.tx, ty: vpRef.current.ty }
  }
  useEffect(() => {
    if (typeof window === 'undefined') return
    const move = (e) => {
      const d = dragRef.current
      if (!d) return
      setVp(v => ({ ...v, tx: d.tx + (e.clientX - d.sx), ty: d.ty + (e.clientY - d.sy) }))
    }
    const up = () => { dragRef.current = null }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  // draw every node that exists in the graph
  const renderNodes = data

  return jsxs('div', {
    ref: frameRef,
    className: 'relative h-full w-full overflow-hidden',
    style: { cursor: dragRef.current ? 'grabbing' : 'default' },
    onWheel,
    onMouseDown: onMouseDownBg,
    children: [
      jsx('button', {
        type: 'button',
        title: 'Fit the full fleet in view',
        'aria-label': 'Fit graph to view',
        onMouseDown: e => e.stopPropagation(),
        onClick: e => { e.stopPropagation(); fitViewport() },
        className: 'absolute right-3 top-3 z-10 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-2 py-1 text-[0.6875rem] font-medium text-(--ui-text-secondary) shadow-sm hover:bg-(--chrome-action-hover)',
        children: 'Fit',
      }, 'fit'),
      jsx('svg', {
      width: '100%', height: '100%',
      className: 'block',
      style: { background: 'var(--surface-canvas)', overflow: 'visible' },
      'data-fleet-canvas': true,
      children: jsx('g', {
        transform: `translate(${vp.tx},${vp.ty}) scale(${vp.scale})`,
        children: [
        // edges first (under nodes)
        ...((() => {
          const edges = []
          for (const [name, n] of Object.entries(renderNodes)) {
            const p = pos[name]
            if (!p || !n.in_graph) continue
            // supervisor edges: elbow route through the gutter between ranks —
            // down from parent bottom-center, across, down into child top.
            // Straight diagonals crossed other node cards; elbows never do.
            for (const [cn, cd] of Object.entries(renderNodes)) {
              if (cd.supervisor === name && pos[cn]) {
                edges.push({
                  key: `sup-${name}-${cn}`, type: 'supervisor',
                  source: name, target: cn,
                  from: { x: p.x + NODE_W / 2, y: p.y + NODE_H },   // parent bottom-center
                  to: { x: pos[cn].x + NODE_W / 2, y: pos[cn].y },  // child top-center
                })
              }
            }
            // peer edges (draw once per pair) — arc beneath both cards
            for (const pn of (n.peers || [])) {
              if (pn <= name) continue
              const pt = pos[pn]
              if (!pt) continue
              edges.push({
                key: `peer-${name}-${pn}`, type: 'peer', curve: true,
                source: name, target: pn,
                from: { x: p.x + NODE_W, y: p.y + NODE_H / 2 },   // right edge midpoint
                to: { x: pt.x, y: pt.y + NODE_H / 2 },            // peer left edge midpoint
                fromY2: Math.max(p.y, pt.y) + NODE_H + 24,
              })
            }
          }
          return edges.map((e, i) => {
            // talking? a recent message between these two bots → glow class.
            // supervisor edges: parent-child pair; peer edges: the pair itself.
            const a = e.source
            const b = e.target
            const talking = a && b && !!(trafficIdx && trafficIdx[pairKey(a, b)])
            const dimmed = !!selected && selected !== a && selected !== b
            return e.curve
            ? jsx('path', {
                d: `M ${e.from.x} ${e.from.y} C ${e.from.x + 40} ${e.fromY2}, ${e.to.x - 40} ${e.fromY2}, ${e.to.x} ${e.to.y}`,
                className: talking ? 'fleet-edge-talk' : (dimmed ? 'fleet-edge-dimmed' : 'fleet-edge-idle'),
                stroke: talking ? undefined : 'var(--fg-success)',
                strokeWidth: talking ? undefined : 1.25,
                strokeDasharray: talking ? undefined : '4,4',
                fill: 'none',
                opacity: talking ? undefined : 0.7,
              }, e.key ?? `edge-${i}`)
            : jsx('path', {
                d: `M ${e.from.x} ${e.from.y} V ${(e.from.y + e.to.y) / 2} H ${e.to.x} V ${e.to.y}`,
                className: talking ? 'fleet-edge-talk' : (dimmed ? 'fleet-edge-dimmed' : 'fleet-edge-idle'),
                stroke: talking ? undefined : 'var(--stroke)',
                strokeWidth: talking ? undefined : 1.25,
                strokeLinejoin: 'round',
                fill: 'none',
              }, e.key ?? `edge-${i}`)
          })
        })()),
        // nodes on top
        ...Object.entries(renderNodes).map(([name, n]) => {
          const p = pos[name]
          if (!p) return null
          const talkingWithSomeone = trafficIdx && Object.keys(trafficIdx).some(k => {
            const [a, b] = k.split('\u0000')
            return a === name || b === name
          })
          return jsx('g', {
            className: (talkingWithSomeone && liveProfiles[name]) ? 'fleet-node-talking' : undefined,
            children: jsx(CanvasNode, {
              name, node: n, p,
              live: !!liveProfiles[name],
              selected, onOpen: onSelect,
            }, name),
          }, `wrap-${name}`)
        }),
        // legend
        jsx('g', {
          transform: `translate(8, ${svgH - 22})`,
          style: { pointerEvents: 'none' },
          children: [
            jsx('line', { x1: 0, y1: 0, x2: 26, y2: 0, stroke: 'var(--stroke)', strokeWidth: 2 }, 'lg1'),
            jsx('text', { x: 32, y: 4, fontSize: 10, fill: 'var(--fg-quaternary)', children: 'chain of command' }, 'lt1'),
            jsx('line', { x1: 150, y1: 0, x2: 176, y2: 0, stroke: 'var(--fg-success)', strokeWidth: 1.5, strokeDasharray: '5,3' }, 'lg2'),
            jsx('text', { x: 182, y: 4, fontSize: 10, fill: 'var(--fg-quaternary)', children: 'peer relation' }, 'lt2'),
            jsx('circle', { cx: 276, cy: 0, r: 4, fill: 'var(--fg-success)' }, 'c1'),
            jsx('text', { x: 286, y: 4, fontSize: 10, fill: 'var(--fg-quaternary)', children: 'complete' }, 't1'),
            jsx('circle', { cx: 348, cy: 0, r: 4, fill: 'var(--fg-warning)' }, 'c2'),
            jsx('text', { x: 358, y: 4, fontSize: 10, fill: 'var(--fg-quaternary)', children: 'in progress / thinking' }, 't2'),
            jsx('circle', { cx: 488, cy: 0, r: 4, fill: 'var(--fg-danger)' }, 'c3'),
            jsx('text', { x: 498, y: 4, fontSize: 10, fill: 'var(--fg-quaternary)', children: 'interrupted' }, 't3'),
            jsx('text', { x: 574, y: 4, fontSize: 10, fill: 'var(--fg-quaternary)', children: '· click a bot · drag to pan · wheel to zoom · Fit resets' }, 'lt4'),
          ]
        }, 'legend'),
        ]
      })
    }, 'canvas')
    ]
  })
}

// ─── error boundary: fail soft, never blank the pane ──────────────
class Boundary extends ReactDefault.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    try { host.logs?.('fleet-graph boundary:', String(error?.message || error)) } catch {}
  }
  render() {
    if (!this.state.error) return this.props.children
    return jsxs('div', { className: 'fleet-graph-root p-6', children: [
      jsx(ErrorState, {
        title: 'the fleet graph view crashed',
        description: String(this.state.error?.message || this.state.error),
      }),
      jsx('div', { className: 'mt-3 flex justify-center', children:
        jsx(Button, { variant: 'outline', onClick: () => this.setState({ error: null }), children: 'Reload view' })
      })
    ] })
  }
}

function draftFromNodes(nodes) {
  return Object.fromEntries(Object.entries(nodes || {}).map(([name, node]) => [name, {
    supervisor: node.supervisor ?? null,
    subordinates: [...(node.subordinates || [])],
    peers: [...(node.peers || [])],
  }]))
}

function mergeNodesWithDraft(nodes, draft) {
  return Object.fromEntries(Object.entries(nodes || {}).map(([name, node]) => {
    const d = draft?.[name]
    const hasSupervisor = d && Object.prototype.hasOwnProperty.call(d, 'supervisor')
    return [name, {
      ...node,
      supervisor: hasSupervisor ? d.supervisor : node.supervisor,
      subordinates: d?.subordinates ? [...d.subordinates] : [...(node.subordinates || [])],
      peers: d?.peers ? [...d.peers] : [...(node.peers || [])],
    }]
  }))
}

function topologyChanged(nodes, draft) {
  if (!nodes || !draft) return false
  const names = new Set([...Object.keys(nodes), ...Object.keys(draft)])
  for (const name of names) {
    const a = nodes[name] || {}
    const b = draft[name] || {}
    const supervisor = Object.prototype.hasOwnProperty.call(b, 'supervisor')
      ? b.supervisor : a.supervisor
    if ((a.supervisor ?? null) !== (supervisor ?? null)) return true
    if (JSON.stringify([...(a.subordinates || [])].sort()) !==
        JSON.stringify([...(b.subordinates || [])].sort())) return true
    if (JSON.stringify([...(a.peers || [])].sort()) !==
        JSON.stringify([...(b.peers || [])].sort())) return true
  }
  return false
}

// ─── optional starter packs ──────────────────────────────────────
function StarterPacksPanel({ nodes }) {
  const qc = useQueryClient()
  const [openId, setOpenId] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [plan, setPlan] = useState(null)
  const packsQ = useQuery({
    queryKey: ['fleet-starter-packs'],
    queryFn: () => api.rest('/starter-packs'),
    staleTime: 5 * 60 * 1000,
  })
  const previewQ = useQuery({
    queryKey: ['fleet-starter-pack', openId],
    queryFn: () => api.rest(`/starter-packs/${openId}`),
    enabled: !!openId,
    staleTime: 5 * 60 * 1000,
  })
  const review = useMutation({
    mutationFn: () => api.rest(`/starter-packs/${openId}/selection`, {
      method: 'POST', body: { profiles: [...selected] },
    }),
    onSuccess: setPlan,
    onError: e => host.notify({ kind: 'error', message: `starter pack review failed: ${String(e?.message || e)}` }),
  })
  const install = useMutation({
    mutationFn: async () => {
      if (!plan?.profiles?.length || !previewQ.data) throw new Error('select at least one profile')
      const graph = Object.fromEntries(Object.entries(nodes || {}).map(([name, node]) => [name, {
        supervisor: node.supervisor ?? null,
        subordinates: [...(node.subordinates || [])],
        peers: [...(node.peers || [])],
      }]))
      const graphKeyFor = name => Object.entries(nodes || {}).find(([key, node]) =>
        key === name || node?.profile === name)?.[0] || name
      const selectedNames = new Set(plan.profiles.map(item => item.name))
      const createdProfiles = []
      try {
        for (const action of plan.profiles) {
          const topo = previewQ.data.topology?.[action.name] || {}
          if (action.action === 'create') {
            await host.request('profiles.create', {
              name: action.name,
              clone_from: action.clone_from,
              description: topo.summary || topo.title || `Fleetgraph member: ${action.name}`,
            })
            createdProfiles.push(action.name)
          }
          const key = graphKeyFor(action.name)
          const supervisorName = topo.supervisor
          const supervisorKey = supervisorName && (
            selectedNames.has(supervisorName) || graphKeyFor(supervisorName) !== supervisorName
          ) ? graphKeyFor(supervisorName) : null
          graph[key] = {
            ...(graph[key] || {}),
            supervisor: supervisorKey,
            subordinates: [...(graph[key]?.subordinates || [])],
            peers: [...(graph[key]?.peers || [])],
          }
          if (supervisorKey) {
            graph[supervisorKey] = graph[supervisorKey] || { supervisor: null, subordinates: [], peers: [] }
            graph[supervisorKey].subordinates = [...new Set([
              ...(graph[supervisorKey].subordinates || []), key,
            ])]
          }
        }
        await api.rest('/graph', { method: 'PUT', body: { nodes: graph } })
        return plan.profiles
      } catch (cause) {
        const rollbackFailures = []
        for (const name of createdProfiles.slice().reverse()) {
          try {
            await host.request('profiles.delete', { name, confirm: true })
          } catch (rollbackError) {
            rollbackFailures.push(`${name}: ${String(rollbackError?.message || rollbackError)}`)
          }
        }
        const remainingProfiles = []
        if (createdProfiles.length) {
          try {
            const inventory = await host.request('profiles.list', { include_sessions: false })
            const names = new Set((inventory?.profiles || []).map(profile => profile?.name || profile))
            for (const name of createdProfiles) {
              if (names.has(name)) remainingProfiles.push(name)
            }
          } catch (inventoryError) {
            rollbackFailures.push(`verification: ${String(inventoryError?.message || inventoryError)}`)
          }
        }
        const residue = [...new Set([...rollbackFailures, ...remainingProfiles.map(name => `${name}: profile remains`)])]
        const suffix = residue.length
          ? `; rollback incomplete: ${residue.join(' | ')}`
          : '; created profiles rolled back and verified absent'
        throw new Error(`${String(cause?.message || cause)}${suffix}`)
      }
    },
    onSuccess: installed => {
      qc.invalidateQueries({ queryKey: ['fleet-graph-overview'] })
      qc.invalidateQueries({ queryKey: ['fleet-starter-pack', openId] })
      setPlan(null)
      setSelected(new Set())
      host.notify({ kind: 'success', message: `${installed.length} starter profile(s) installed/adopted and wired` })
    },
    onError: e => host.notify({ kind: 'error', message: `starter pack install failed: ${String(e?.message || e)}` }),
  })

  const validPacks = (packsQ.data?.packs || []).filter(pack => pack.valid)
  if (!validPacks.length) return null
  const preview = previewQ.data
  const allNames = (preview?.profiles || []).map(profile => profile.name)
  const toggleAll = () => setSelected(current => current.size === allNames.length ? new Set() : new Set(allNames))

  return jsxs('div', { className: 'mx-4 mb-2 rounded-lg border border-(--ui-stroke-secondary) p-2.5', children: [
    jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
      jsxs('div', { children: [
        jsx('div', { className: 'text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)', children: 'optional starter packs' }),
        jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: 'data-only templates — preview, select, approve' }),
      ] }),
      jsx('div', { className: 'flex gap-1', children: validPacks.map(pack => jsx(Button, {
        size: 'sm', variant: openId === pack.id ? 'outline' : undefined,
        onClick: () => { setOpenId(pack.id); setPlan(null); setSelected(new Set()) },
        children: openId === pack.id ? 'Hide pack' : `Preview ${pack.title}`,
      }, pack.id)) }),
    ] }),
    preview && jsxs('div', { className: 'mt-2 border-t border-(--ui-stroke-secondary) pt-2', children: [
      jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
        jsxs('div', { className: 'text-xs', children: [
          jsx('span', { className: 'font-medium', children: preview.title }),
          jsx('span', { className: 'ml-2 text-(--ui-text-secondary)', children: `${preview.profiles?.length || 0} profiles · ${preview.license}` }),
        ] }),
        jsx('button', { type: 'button', onClick: toggleAll, className: 'text-[0.6875rem] text-(--ui-accent)', children: selected.size === allNames.length ? 'clear all' : 'select all' }),
      ] }),
      jsx('div', { className: 'mt-1 max-h-40 overflow-auto rounded border border-(--ui-stroke-secondary) p-1', children:
        (preview.profiles || []).map(profile => jsx('label', { className: 'flex items-center gap-2 px-1 py-0.5 text-[0.6875rem]', children: [
          jsx(Checkbox, { checked: selected.has(profile.name), onCheckedChange: checked => setSelected(current => {
            const next = new Set(current)
            if (checked) next.add(profile.name)
            else next.delete(profile.name)
            return next
          }) }, `pack-${profile.name}`),
          jsx('span', { className: 'font-mono', children: profile.name }),
          jsx('span', { className: 'text-(--ui-text-secondary)', children: profile.installed ? 'adopt' : `create from ${profile.clone_from || 'review'}` }),
        ] }, profile.name))
      }),
      jsxs('div', { className: 'mt-2 flex items-center justify-between gap-2', children: [
        jsx('span', { className: 'text-[0.625rem] text-(--ui-text-secondary)', children: 'No profile or graph mutation occurs during preview.' }),
        jsx(Button, { size: 'sm', disabled: !selected.size || review.isPending, onClick: () => review.mutate(), children: review.isPending ? 'reviewing…' : 'Review selected' }),
      ] }),
      plan && jsxs('div', { className: 'mt-2 rounded border border-(--ui-accent) p-2', children: [
        jsx('div', { className: 'text-xs font-medium', children: `Approval required: ${plan.profiles.length} profile(s)` }),
        jsx('div', { className: 'mt-1 text-[0.6875rem] text-(--ui-text-secondary)', children: plan.profiles.map(item => `${item.name}: ${item.action}${item.clone_from ? ` ← ${item.clone_from}` : ''}`).join(' · ') }),
        jsx(Button, { className: 'mt-2', size: 'sm', disabled: install.isPending, onClick: () => install.mutate(), children: install.isPending ? 'installing…' : 'Approve & install selected' }),
      ] }),
    ] }),
  ] })
}

// ─── approval-gated fleet workflows ───────────────────────────────
function WorkflowPanel({ nodes }) {
  const qc = useQueryClient()
  const [mode, setMode] = useState(null)
  const [hierarchyPlan, setHierarchyPlan] = useState(null)
  const workflowsQ = useQuery({
    queryKey: ['fleet-workflows'],
    queryFn: () => api.rest('/workflows'),
    staleTime: 5 * 60 * 1000,
  })
  const advisorQ = useQuery({
    queryKey: ['fleet-advisor-preview'],
    queryFn: () => api.rest('/advisor/preview?days=30'),
    enabled: mode === 'advisor',
    staleTime: 30 * 1000,
  })
  const insightsQ = useQuery({
    queryKey: ['fleet-advisor-insights'],
    queryFn: () => host.request('insights.get', { days: 30 }),
    enabled: mode === 'advisor',
    staleTime: 30 * 1000,
  })
  const hierarchyPreview = useMutation({
    mutationFn: () => {
      const draft = Object.fromEntries(Object.entries(nodes || {}).map(([name, node]) => [name, {
        supervisor: node.supervisor ?? null,
        subordinates: [...(node.subordinates || [])],
        peers: [...(node.peers || [])],
      }]))
      return api.rest('/hierarchy/preview', { method: 'POST', body: { nodes: draft } })
    },
    onSuccess: setHierarchyPlan,
    onError: e => host.notify({ kind: 'error', message: `hierarchy preview failed: ${String(e?.message || e)}` }),
  })
  const hierarchyApply = useMutation({
    mutationFn: () => {
      if (!hierarchyPlan?.after) throw new Error('preview the hierarchy first')
      const draft = Object.fromEntries(Object.entries(nodes || {}).map(([name, node]) => [name, {
        supervisor: node.supervisor ?? null,
        subordinates: [...(node.subordinates || [])],
        peers: [...(node.peers || [])],
      }]))
      return api.rest('/hierarchy/apply', { method: 'PUT', body: { nodes: draft, confirm: true } })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fleet-graph-overview'] })
      setHierarchyPlan(null)
      host.notify({ kind: 'success', message: 'Approved hierarchy applied atomically' })
    },
    onError: e => host.notify({ kind: 'error', message: `hierarchy apply failed: ${String(e?.message || e)}` }),
  })
  const workflows = workflowsQ.data?.workflows || []
  if (!workflows.length) return null
  const advisor = workflows.find(item => item.id === 'fleet-bot-advisor')
  const hierarchy = workflows.find(item => item.id === 'fleet-hierarchy-builder')
  return jsxs('div', { className: 'mx-4 mb-2 rounded-lg border border-(--ui-stroke-secondary) p-2.5', children: [
    jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
      jsxs('div', { children: [
        jsx('div', { className: 'text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)', children: 'fleet workflows' }),
        jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: 'local signals, review first, explicit approval' }),
      ] }),
      jsxs('div', { className: 'flex gap-1', children: [
        advisor && jsx(Button, { size: 'sm', variant: mode === 'advisor' ? 'outline' : undefined, onClick: () => { setMode(mode === 'advisor' ? null : 'advisor'); setHierarchyPlan(null) }, children: 'Review advisor' }),
        hierarchy && jsx(Button, { size: 'sm', variant: mode === 'hierarchy' ? 'outline' : undefined, onClick: () => { setMode(mode === 'hierarchy' ? null : 'hierarchy'); setHierarchyPlan(null) }, children: 'Build hierarchy' }),
      ] }),
    ] }),
    mode === 'advisor' && jsxs('div', { className: 'mt-2 border-t border-(--ui-stroke-secondary) pt-2', children: [
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: 'Advisor observes coarse local counts, summarizes them, recommends a review, and stops before profile creation.' }),
      jsx('div', { className: 'mt-1 text-xs', children: insightsQ.isLoading ? 'reading coarse activity…' : `last 30 days: ${insightsQ.data?.sessions || 0} sessions · ${insightsQ.data?.messages || 0} messages` }),
      (advisorQ.data?.recommendations || []).map(item => jsxs('div', { className: 'mt-1 rounded border border-(--ui-stroke-secondary) p-1.5 text-[0.6875rem]', children: [
        jsx('div', { className: 'font-medium', children: item.reason }),
        jsx('div', { className: 'text-(--ui-text-secondary)', children: `${item.next_step} Source: ${item.source}` }),
      ] }, item.id)),
      jsx('div', { className: 'mt-1 text-[0.625rem] text-(--ui-text-secondary)', children: 'No automatic profile creation. Use the starter-pack review above and approve each selected action yourself.' }),
    ] }),
    mode === 'hierarchy' && jsxs('div', { className: 'mt-2 border-t border-(--ui-stroke-secondary) pt-2', children: [
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-secondary)', children: 'Draft changes are validated for cycles, unknown profiles, and duplicate edges before any write.' }),
      jsx(Button, { className: 'mt-1', size: 'sm', disabled: hierarchyPreview.isPending, onClick: () => hierarchyPreview.mutate(), children: hierarchyPreview.isPending ? 'previewing…' : 'Preview hierarchy diff' }),
      hierarchyPlan && jsxs('div', { className: 'mt-2 rounded border border-(--ui-accent) p-2', children: [
        jsx('div', { className: 'text-xs font-medium', children: `${hierarchyPlan.changed_profiles?.length || 0} profile(s) in draft diff` }),
        jsx('div', { className: 'mt-1 text-[0.6875rem] text-(--ui-text-secondary)', children: (hierarchyPlan.changed_profiles || []).join(' · ') || 'No topology changes detected.' }),
        jsx(Button, { className: 'mt-2', size: 'sm', disabled: hierarchyApply.isPending || !hierarchyPlan.valid, onClick: () => hierarchyApply.mutate(), children: hierarchyApply.isPending ? 'applying…' : 'Approve & apply hierarchy' }),
      ] }),
    ] }),
  ] })
}

// ─── page ────────────────────────────────────────────────────────
function FleetGraphPage() {
  useTokens()
  const qc = useQueryClient()
  const q = useOverview()
  const trafficIdx = useTrafficIndex()
  const {
    backendDisabled,
    backendNeedsRestart,
    enable: enableBackend,
    remount: remountRoutes,
  } = useBackendHeal(q.isError)
  const [selected, setSelected] = useState(null)
  const [draft, setDraft] = useState(null)
  const [creating, setCreating] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [err, setErr] = useState(null)
  const [view, setView] = useState('tree') // 'tree' | 'canvas'
  const [liveProfiles, setLiveProfiles] = useState({})
  const [tailOpen, setTailOpen] = useState(null)
  const [inspectorTab, setInspectorTab] = useState('live')
  const roster = useRoster()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  // canvas click: select the bot AND slide open its live tail drawer
  const handleSelect = (name) => {
    setSelected(name)
    setTailOpen(name || null)
  }
  const closeInspector = () => {
    setTailOpen(null)
    setSelected(null)
  }

  // Escape closes the inspector and clears canvas selection so unrelated
  // edges do not stay dimmed after the drawer is gone.
  useEffect(() => {
    if ((!tailOpen && !selected) || typeof window === 'undefined') return
    const onKey = e => { if (e.key === 'Escape') closeInspector() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tailOpen, selected])

  const data = q.data

  // Polls can remove a selected profile (deletion, alias cleanup, external
  // graph edit). Clear both pointers instead of retaining a stale selection.
  useEffect(() => {
    if (!data?.nodes) return
    if (selected && !data.nodes[selected]) setSelected(null)
    if (tailOpen && !data.nodes[tailOpen]) setTailOpen(null)
  }, [data?.nodes, selected, tailOpen])

  // live activity: subscribe to gateway events, paint per-profile status
  useEffect(() => {
    const off = host.onEvent('*', (event) => {
      const p = event.profile
      if (!p || !event.type) return
      const isLifecycle = event.type.startsWith('tool.') ||
        event.type.startsWith('message.') ||
        event.type.startsWith('reasoning.') ||
        event.type === 'status.update'
      if (!isLifecycle) return
      if (event.type === 'message.complete') {
        // Completed turns are persisted by the gateway after the event. Pull
        // the transcript and activity snapshot immediately; polling remains
        // the fallback for remotes that do not deliver gateway events.
        qc.invalidateQueries({ queryKey: ['fleet-tail-msgs'] })
        qc.invalidateQueries({ queryKey: ['fleet-graph-overview'] })
      } else if (event.type === 'tool.complete') {
        qc.invalidateQueries({ queryKey: ['fleet-graph-overview'] })
      }
      setLiveProfiles(lpv => {
        const next = { ...lpv }
        if (event.type === 'message.complete' || event.type === 'tool.complete') {
          // clear pulse after a short delay
          next[p] = { ...next[p], active: false }
          setTimeout(() => setLiveProfiles(l => {
            const nx = { ...l }
            if (nx[p] && !nx[p].active) delete nx[p]
            return nx
          }), 3000)
        } else {
          next[p] = { active: true, type: event.type }
        }
        return next
      })
    })
    return off
  }, [])

  const dirty = topologyChanged(data?.nodes, draft)
  useEffect(() => {
    if (!data?.nodes) return
    if (draft) {
      const present = new Set(Object.keys(data.nodes))
      const pruned = Object.fromEntries(Object.entries(draft)
        .filter(([name]) => present.has(name)))
      if (Object.keys(pruned).length !== Object.keys(draft).length) {
        // A profile was deleted through the built-in Bots page. Drop only that
        // stale draft member; preserve unrelated unsaved rewires.
        setDraft(pruned)
        return
      }
    }
    if (draft === null || !topologyChanged(data.nodes, draft)) {
      setDraft(draftFromNodes(data.nodes))
    }
  }, [data?.nodes, dirty])

  const save = useMutation({
    mutationFn: payload => api.rest('/graph', { method: 'PUT', body: payload }),
    onSuccess: () => {
      setErr(null)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2500)
      qc.invalidateQueries({ queryKey: ['fleet-graph-overview'] })
      q.refetch?.()
      host.notify({ kind: 'success', message: 'Chain of command updated' })
    },
    onError: e => setErr(String(e?.message || e))
  })

  // mark-read handler — optimistic: zero the badge immediately from the
  // cached overview data, then confirm with a background refetch. The old
  // invalidate-only flow raced the 8 s poll interval and left stale badges.
  const markRead = (name) => {
    qc.setQueryData(['fleet-graph-overview'], (old) => {
      if (!old?.nodes?.[name]) return old
      return {
        ...old,
        nodes: {
          ...old.nodes,
          [name]: { ...old.nodes[name], unread: 0 },
        },
      }
    })
    api.rest(`/inbox/${name}/read`, { method: 'POST', body: {} })
      .then(() => {
        qc.invalidateQueries({ queryKey: ['fleet-graph-overview'] })
        qc.invalidateQueries({ queryKey: ['fleet-inbox', name] })
        host.notify({ kind: 'success', message: `Inbox marked read for ${name}` })
      })
      .catch(e => {
        // roll the optimistic update back on failure
        qc.invalidateQueries({ queryKey: ['fleet-graph-overview'] })
        host.notify({ kind: 'error', message: String(e?.message || e) })
      })
  }

  // overview failed entirely → error state with retry (ladder rung 5:
  // bounded recovery affordance, never an infinite spinner). If the backend
  // is merely not enabled, offer the one-click self-heal instead.
  if (q.isError) {
    return jsxs('div', { className: 'fleet-graph-root p-6', children: [
      jsx(ErrorState, {
        title: backendDisabled
          ? 'the fleet graph backend is not enabled'
          : backendNeedsRestart
            ? 'backend enabled, but its routes are not mounted yet'
            : 'could not read the fleet graph',
        description: backendDisabled
          ? 'The UI loaded, but its Python API is switched off in config.yaml (plugins.enabled). Enable it below — or add "fleet-graph" to plugins.enabled manually.'
          : backendNeedsRestart
            ? 'config.yaml already lists this plugin, but the running Hermes backend did not mount its API routes. Remount them below; if this Hermes version lacks live remount support, restart the dashboard once and press Retry.'
            : String(q.error?.message || q.error || 'the backend did not answer'),
      }),
      backendDisabled && jsx('div', { className: 'flex justify-center', children:
        jsx(Button, {
          disabled: enableBackend.isPending,
          onClick: () => enableBackend.mutate(),
          children: enableBackend.isPending ? 'enabling…' : 'Enable backend'
        })
      }),
      backendNeedsRestart && jsx('div', { className: 'flex justify-center', children:
        jsx(Button, {
          disabled: remountRoutes.isPending,
          onClick: () => remountRoutes.mutate(),
          children: remountRoutes.isPending ? 'remounting…' : 'Remount routes'
        })
      }),
      jsx('div', { className: 'flex justify-center mt-2', children:
        jsx(Button, { variant: 'outline', onClick: () => q.refetch(), children: 'Retry' })
      })
    ] })
  }

  if (q.isLoading || !draft) {
    return jsxs('div', { className: 'fleet-graph-root p-4', children: [
      jsx('div', { className: 'mb-2 text-sm text-(--ui-text-secondary)', children: 'reading the chain of command…' }),
      ...[0, 1, 2, 3].map(i => jsx(Skeleton, { className: 'mb-2 h-9 w-full rounded-lg' }, `sk${i}`))
    ] })
  }

  const nodes = mergeNodesWithDraft(data.nodes, draft)
  const profiles = Object.keys(nodes).sort()
  const rosterByProfile = roster.data?.roster || {}
  const profileOf = (n) => nodes[n]?.profile || n
  const capOf = (n) => rosterByProfile[profileOf(n)]

  const matchesFilter = (n) => {
    const v = nodes[n]
    if (statusFilter === 'attention') {
      const st = v.latest_session?.status
      if (!(v.unread > 0 || st === 'interrupted')) return false
    } else if (statusFilter !== 'all') {
      const st = v.latest_session?.status || 'idle'
      if (statusFilter === 'active' && !['active'].includes(st)) return false
      if (statusFilter === 'idle' && !['idle', 'complete', 'no-session', ''].includes(st)) return false
    }
    if (!search.trim()) return true
    const hay = `${n} ${v.title || ''} ${v.description || ''} ${capOf(n)?.summary || ''}`.toLowerCase()
    return search.toLowerCase().split(/\s+/).every(w => hay.includes(w))
  }

  // filtered topology: a node survives if it matches OR any descendant matches
  const childrenAll = (parent) => profiles.filter(p => (draft[p]?.supervisor || null) === parent)
  const subtreeMatches = (n, seen = new Set()) => {
    if (seen.has(n)) return false
    seen.add(n)
    if (matchesFilter(n)) return true
    return childrenAll(n).some(k => subtreeMatches(k, seen))
  }
  const visibleProfiles = profiles.filter(n => {
    // keep an ancestor chain: show node if it matches, or if it's an ancestor of a match
    if (matchesFilter(n)) return true
    return childrenAll(n).some(k => subtreeMatches(k))
  })
  const seenCanonicalProfiles = new Set()
  const profilesF = visibleProfiles.filter(n => {
    const canonical = profileOf(n)
    if (seenCanonicalProfiles.has(canonical)) return false
    seenCanonicalProfiles.add(canonical)
    return true
  })
  const unassigned = profilesF.filter(n => !nodes[n]?.in_graph)

  // ── deck v2: team-grouped flat cards. Hierarchy = section headers, not indents.
  const cardOf = (name) => {
    const talking = !!(trafficIdx && liveProfiles[name] && Object.keys(trafficIdx).some(k => {
      const [a, b] = k.split('\u0000')
      return a === name || b === name
    }))
    return jsx(BotCard, {
      name, node: nodes[name], talking,
      selected, onSelect: handleSelect,
      onMarkRead: markRead,
      rosterCap: capOf(name),
    }, name)
  }
  const SectionHeader = ({ label, count }) => jsx('div', {
    className: 'mb-1.5 mt-4 flex items-center gap-2 px-1 first:mt-0', children: [
      jsx('span', { className: 'text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)', children: label }),
      count != null && jsx('span', { className: 'rounded-full bg-(--chrome-action-hover) px-1.5 text-[0.625rem] font-medium text-(--ui-text-secondary)', children: count }),
    ]
  })
  // teams: every supervisor with >=1 report in view
  const teamLeads = profilesF.filter(p => childrenAll(p).length > 0).sort()

  const savePayload = Object.fromEntries(profiles.map(n => [n, {
    supervisor: draft[n]?.supervisor ?? null,
    subordinates: draft[n]?.subordinates ?? [],
    peers: draft[n]?.peers ?? []
  }]))
  const relationsPayload = {}
  for (const [n, v] of Object.entries(savePayload)) {
    for (const p of (v.peers || [])) {
      if (n < p) relationsPayload[n] = [...(relationsPayload[n] || []), p]
    }
  }

  return jsxs('div', { className: cn('fleet-graph-root', 'relative flex h-full flex-col'), children: [
    creating && jsx(CreateProfile, {
      onDone: () => setCreating(false),
      onClose: () => setCreating(false),
      existingProfiles: nodes
    }),
    jsxs('div', { className: 'flex items-center gap-3 px-4 pt-3 pb-2 border-b border-(--ui-stroke-secondary)', children: [
      jsxs('div', { className: 'flex items-baseline gap-2', children: [
        jsx('div', { className: 'text-base font-semibold', children: 'Fleet Command' }),
        jsx('span', { className: 'rounded-full border border-(--ui-stroke-secondary) px-1.5 text-[0.5625rem] font-mono uppercase tracking-wider text-(--ui-text-secondary)', children: 'v0.8.0' }),
      ] }),
      // view switch — Deck (command center) / Graph (topology drawing)
      jsx(SegmentedControl, {
        options: [
          { id: 'tree', label: 'Deck' },
          { id: 'canvas', label: 'Graph' },
        ],
        value: view,
        onChange: setView,
      }),
      jsx('div', { className: 'flex flex-1 items-center gap-4 text-[0.6875rem] text-(--ui-text-secondary)', children: (() => {
        const seen = new Set()
        const all = Object.entries(nodes)
          .filter(([name, node]) => {
            const canonical = node.profile || name
            if (seen.has(canonical)) return false
            seen.add(canonical)
            return true
          })
          .map(([, v]) => v)
        const conversing = all.filter(v => v.latest_session?.status === 'active').length
        const attention = all.filter(v => (v.unread || 0) > 0 || v.latest_session?.status === 'interrupted').length
        return [
          jsxs('span', { children: [all.length, ' bots'] }, 'st-bots'),
          conversing > 0 ? jsx('span', { style: { color: 'var(--fg-accent)' }, children: `${conversing} conversing` }, 'st-live') : null,
          attention > 0 ? jsx('span', { style: { color: 'var(--fg-warning)' }, children: `${attention} need attention` }, 'st-attn') : null,
        ]
      })() }),
      jsx(Button, {
        size: 'sm', onClick: () => setCreating(true),
        children: '+ New member'
      })
    ] }),
    jsx(StarterPacksPanel, { nodes }),
    jsx(WorkflowPanel, { nodes }),
    // search + status filter row (tree view only)
    view === 'tree' && jsxs('div', { className: 'flex items-center gap-2 px-4 pb-1.5', children: [
      jsx(Input, {
        value: search, onChange: e => setSearch(e.target.value),
        placeholder: 'search bots, roles, capabilities…',
        className: 'h-6 max-w-64 flex-1 text-xs',
      }),
      jsx('div', { className: 'flex gap-1', children:
        [['all', 'All'], ['active', 'Conversing'], ['idle', 'Idle'], ['attention', 'Needs attention']].map(([k, label]) =>
          jsx('button', {
            type: 'button', onClick: () => setStatusFilter(k),
            className: cn('rounded-full border px-2 py-px text-[0.6875rem] transition-colors',
              statusFilter === k
                ? 'border-(--ui-accent) bg-(--ui-accent)/10 font-medium text-(--ui-accent)'
                : 'border-(--ui-stroke-secondary) text-(--ui-text-secondary) hover:text-(--ui-text-secondary)'),
            children: label
          }, k))
      }),
    ] }),
    view === 'canvas'
      ? jsxs('div', { className: 'relative min-h-0 flex-1', children: [
          jsx(CanvasGraph, {
            nodes, draft, setDraft, profiles,
            selected, onSelect: handleSelect, onMarkRead: markRead,
            liveProfiles: liveProfiles, trafficIdx
          }),
          tailOpen && nodes[tailOpen] && jsx(Inspector, {
            name: tailOpen, node: nodes[tailOpen],
            tab: inspectorTab, setTab: setInspectorTab,
            onClose: closeInspector, onMarkRead: markRead,
            draft, setDraft, profiles,
            rosterCap: capOf(tailOpen),
            hasUnsavedChanges: dirty,
          }),
        ] })
      : jsxs('div', { className: 'flex min-h-0 flex-1 overflow-hidden', children: [
          // center: the deck — attention first, then the full chain
          jsxs('div', { className: 'min-w-0 flex-1 overflow-auto p-3', children: [
            // ── NEEDS ATTENTION: unread or interrupted — triage pile first ──
            (() => {
              const attention = profilesF.filter(n => (nodes[n].unread || 0) > 0 || nodes[n].latest_session?.status === 'interrupted')
              if (!attention.length) return null
              return jsxs('div', { className: 'mb-5', children: [
                jsxs('div', { className: 'mb-1.5 flex items-center gap-2 px-1', children: [
                  jsx('span', { className: 'fleet-section-tick', style: { background: 'var(--fg-warning)' } }, 'tick'),
                  jsx('span', { className: 'text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-(--fg-warning)', children: 'needs attention' }, 'label'),
                  jsx('span', { className: 'fleet-count-pill', children: attention.length }, 'count'),
                ] }),
                attention.map(cardOf),
              ] })
            })(),
            // ── TEAMS: one section per supervisor, flush cards, zero indents ──
            teamLeads.length > 0 && jsx('div', { className: 'mb-2 px-1 text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)', children: 'teams' }),
            teamLeads.map(lead => {
              const members = childrenAll(lead)
              const leadShown = matchesFilter(lead) || members.some(m => matchesFilter(m))
              if (!leadShown) return null
              const capL = capOf(lead)
              const leadSession = nodes[lead]?.latest_session
              return jsxs('div', { className: 'mb-4', children: [
                jsxs('button', {
                  type: 'button',
                  onClick: () => handleSelect(tailOpen === lead ? null : lead),
                  className: cn('mb-1.5 flex w-full items-baseline gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-(--chrome-action-hover)/50',
                    tailOpen === lead && 'bg-(--chrome-action-hover)'),
                  children: [
                    jsx('span', { className: 'text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-(--ui-text-secondary)', children: lead }),
                    jsx('span', { className: 'text-[0.625rem] text-(--ui-text-secondary)', children: `${members.length} report${members.length === 1 ? '' : 's'}` }),
                    capL?.summary ? jsx('span', { className: 'min-w-0 flex-1 truncate text-[0.625rem] text-(--ui-text-secondary)', children: capL.summary.slice(0, 70) }) : null,
                    jsx(StatusChip, { status: leadSession?.status, lastActive: leadSession?.last_active }, 'lead-status'),
                  ]
                }),
                members.map(m => cardOf(m)),
              ] }, `team-wrap-${lead}`)
            }),
            // ── UNASSIGNED: import controls ──
            unassigned.length > 0 && jsxs('div', { className: 'mb-4 rounded-lg border border-dashed border-(--ui-stroke-secondary) p-2.5', children: [
              jsxs('div', { className: 'mb-1.5 flex items-center justify-between gap-2', children: [
                jsx('div', { className: 'text-[0.625rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-secondary)', children: `discovered profiles not in the chain (${unassigned.length})` }),
                jsx('button', {
                  type: 'button',
                  onClick: () => setDraft(d => {
                    const next = structuredClone(d)
                    // anchor: first wired root (draft wins over disk); none -> they join as their own roots
                    const supOf = n => next[n]?.supervisor ?? data.nodes[n]?.supervisor ?? null
                    const anchor = profiles.find(p => !unassigned.includes(p) && !supOf(p))
                    for (const u of unassigned) {
                      next[u] = next[u] || { supervisor: null, subordinates: [] }
                      next[u].supervisor = anchor || null
                      if (anchor) {
                        next[anchor] = next[anchor] || { supervisor: null, subordinates: [] }
                        next[anchor].subordinates = [...new Set([...(next[anchor].subordinates || []), u])]
                      }
                    }
                    return next
                  }),
                  className: 'rounded-md border border-(--ui-stroke-secondary) px-2 py-0.5 text-[0.625rem] font-medium hover:bg-(--chrome-action-hover)',
                  children: 'import all'
                }),
              ] }),
              jsxs('div', { className: 'flex flex-col gap-1.5', children: unassigned.map(u => jsxs('div', { className: 'flex items-center gap-2', children: [
                jsx(Pill, { children: u }, `pill-${u}`),
                jsx(Select, {
                  value: '', className: 'h-6 w-44 rounded-full px-1 text-[0.6875rem]',
                  onChange: v => {
                    if (!v) return
                    setDraft(d => {
                      const next = structuredClone(d)
                      next[u] = next[u] || { supervisor: null, subordinates: [] }
                      next[u].supervisor = v
                      next[v] = next[v] || { supervisor: null, subordinates: [] }
                      next[v].subordinates = [...new Set([...(next[v].subordinates || []), u])]
                      return next
                    })
                  },
                  children: [
                    jsx('option', { value: '', children: 'attach under…' }, 'ph'),
                    ...profiles.filter(p => p !== u).map(p => jsx('option', { value: p, children: p }, p)),
                  ]
                }),
              ] }, `ua-${u}`)) })
            ] }),
            teamLeads.length === 0 && !unassigned.length &&
              jsx('div', { className: 'px-1 py-8 text-center text-xs text-(--ui-text-secondary)', children: 'no bots match the current filter' }),
          ] }),
          // right zone: docked inspector — always visible when a bot is selected
          tailOpen && nodes[tailOpen] ? jsxs('div', { className: 'relative w-[24rem] shrink-0 border-l border-(--ui-stroke-secondary)', children: [
            jsx(Inspector, {
              name: tailOpen, node: nodes[tailOpen],
              tab: inspectorTab, setTab: setInspectorTab,
              onClose: closeInspector, onMarkRead: markRead,
              draft, setDraft, profiles,
              rosterCap: capOf(tailOpen),
              docked: true,
              hasUnsavedChanges: dirty,
            }),
          ] }) : jsx('div', { className: 'hidden w-[24rem] shrink-0 border-l border-(--ui-stroke-secondary) lg:block', children:
            jsxs('div', { className: 'fleet-inspector-empty', children: [
              jsx('div', { className: 'fleet-inspector-empty-icon', 'aria-hidden': true, children: '↳' }, 'icon'),
              jsx('div', { className: 'text-[0.6875rem] uppercase tracking-[0.08em] text-(--ui-text-secondary)', children: 'inspector' }, 'title'),
              jsx('div', { className: 'text-xs leading-5 text-(--ui-text-secondary)', children:
                'Select a bot from the deck to see its live transcript, inbox, and wiring here.' }, 'help'),
            ] }) }),
        ] }),
    jsxs('div', { className: cn('flex items-center gap-2 border-t border-(--ui-stroke-secondary) px-4 py-2'), children: [
      dirty && !err && jsx('span', { className: 'text-xs text-(--ui-text-secondary)', children: 'unsaved changes' }),
      savedFlash && !err && jsx('span', { className: 'text-xs', style: { color: 'var(--fg-success)' }, children: 'saved' }),
      err && jsx('span', { className: 'min-w-0 flex-1 truncate text-xs text-(--fg-danger)', title: err, children: err }),
      dirty && jsx('button', {
        type: 'button', onClick: () => setDraft(structuredClone(
          Object.fromEntries(Object.entries(data.nodes).map(([n, v]) => [n, {
            supervisor: v.supervisor, subordinates: [...(v.subordinates || [])]
          }]))
        )),
        className: 'rounded-md border border-(--ui-stroke-secondary) px-2.5 py-1 text-xs hover:bg-(--chrome-action-hover)',
        children: 'discard'
      }),
      jsx('button', {
        type: 'button',
        disabled: !dirty || save.isPending,
        onClick: () => save.mutate({ nodes: savePayload, relations: relationsPayload }),
        className: cn('rounded-md bg-(--ui-accent) px-3 py-1 text-xs font-medium text-(--color-primary-foreground) disabled:opacity-40'),
        children: save.isPending ? 'saving…' : 'Save chain of command'
      })
    ] })
  ] })
}

export default {
  id: ID,
  name: 'Fleetgraph',
  register(ctx) {
    api = ctx
    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/fleet-graph' },
      render: () => jsx(Boundary, { children: jsx(FleetGraphPage, {}) })
    })
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      order: 50,
      data: { path: '/fleet-graph', label: 'Fleet Command', codicon: 'git-branch' }
    })
  }
}
