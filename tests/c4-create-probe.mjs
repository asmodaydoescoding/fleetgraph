import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { pluginPath, sdkStubPath, underTestPath, prepareHarnessDirs } from './helpers/paths.mjs'
import { CAPTAIN, PLANNER, fleetNode } from './helpers/generic-fleet.mjs'
const require = createRequire(import.meta.url)
prepareHarnessDirs()
const React = require('react')
const RTR = require('react-test-renderer')
writeFileSync(sdkStubPath, `
import React from 'react'
const cache = new Map()
export function useQuery({ queryKey, queryFn, enabled = true }) {
  const k = JSON.stringify(queryKey)
  const [state, setState] = React.useState(() =>
    cache.has(k) ? { data: cache.get(k), isLoading: false } : { data: undefined, isLoading: !!enabled })
  React.useEffect(() => {
    if (enabled === false || cache.has(k)) return
    let alive = true
    queryFn().then(d => { cache.set(k, d); if (alive) setState({ data: d, isLoading: false }) },
                  () => { if (alive) setState({ data: undefined, isLoading: false, isError: true }) })
    return () => { alive = false }
  }, [k, enabled])
  return state
}
export function useMutation(o={}){ return { isPending:false, mutate(a){ this.lastArgs=a; o.mutationFn?.(a) } } }
export const useQueryClient = () => ({ invalidateQueries(){}, setQueryData(){} })
export const cn=(...a)=>a.filter(Boolean).join(' ')
globalThis.__hostCalls = []
export const host={ request:(m,p)=>{
  globalThis.__hostCalls.push({m,p})
  if (m === 'profiles.describe') return Promise.resolve({skills:[],toolsets:[]})
  if (m === 'profiles.list') return Promise.resolve({profiles:[
    null, {}, 0, {name:'captain'}, {name:'planner'}, {name:'researcher'}, '../escape'
  ]})
  return Promise.resolve({providers:[]})
}, onEvent:()=>()=>{}, notify(o){globalThis.__n=o} }
export const ROUTES_AREA='routes'; export const SIDEBAR_NAV_AREA='sidebar-nav'
export function SegmentedControl({options}){return React.createElement('div',null)}
export function Button(props){ return React.createElement('button',props) }
export function Input(p){return React.createElement('input',p)}
export function Textarea(p){return React.createElement('textarea',p)}
export function Checkbox(p){return React.createElement('input',{type:'checkbox',...p})}
export function Badge(c){return React.createElement('span',null,c.children)}
export function Dialog(c){return React.createElement('div',null,c.children)}
export function DialogContent(p){return React.createElement('div',null,p.children)}
export function DialogHeader(p){return React.createElement('div',null,p.children)}
export function DialogTitle(p){return React.createElement('h2',null,p.children)}
export function DialogDescription(p){return React.createElement('p',null,p.children)}
export function DialogFooter(p){return React.createElement('div',null,p.children)}
export function Select(props){
  const groups=Array.isArray(props.children)?props.children:[props.children]
  const content=groups.find(c=>c?.type==='select-content')
  const items=Array.isArray(content?.props?.children)?content.props.children:[content?.props?.children]
  const options=items.filter(Boolean)
  globalThis.__selectItems=[...(globalThis.__selectItems||[]), options.map(o=>({value:o?.props?.value,label:o?.props?.children??''}))]
  return React.createElement('select',{value:props.value,onChange:e=>props.onValueChange?.(e.target.value)},
    options.map((o,i)=>React.createElement('option',{key:i,value:o?.props?.value??''},o?.props?.children??'')))
}
export function SelectContent(p){return React.createElement('select-content',p)}
export function SelectItem(p){return React.createElement('option',p)}
export function SelectTrigger(p){return React.createElement('select-trigger',p)}
export function SelectValue(p){return React.createElement('select-value',p)}
export function ErrorState(t){return React.createElement('div',null,t.title)}
export function Skeleton(p){return React.createElement('div',p)}
`)
// import the CreateProfile component via the plugin module (not exported) — drive it through
// the page instead. Simpler: replicate its validation logic by importing module internals is
// impossible, so test through the full page like loop6 does.
const src = readFileSync(pluginPath,'utf8')
writeFileSync(underTestPath, src)
const mod = await import(pathToFileURL(underTestPath).href+'?v='+Date.now())
const contributions=[]
globalThis.__restCalls = []
mod.default.register({
  rest: (p, opts) => {
    globalThis.__restCalls.push({p, opts})
    if (p.startsWith('/overview')) return Promise.resolve({ nodes: {
      [CAPTAIN]: fleetNode({ name: CAPTAIN, subordinates: [], depth: 0 }),
      [PLANNER]: fleetNode({ name: PLANNER, supervisor: CAPTAIN, subordinates: [], depth: 1 }),
    }})
    return Promise.resolve({})
  },
  register:c=>contributions.push(c), storage:{get:()=>null,set:()=>{}},
})
const pg = contributions.find(c=>c.area==='routes'&&c.data?.path==='/fleet-graph')
let renderer, mountErr = null
try {
  await RTR.act(async()=>{ renderer = RTR.create(pg.render()); await new Promise(r=>setTimeout(r,300)) })
} catch(e){ mountErr = e }
if (mountErr) console.log('MOUNT ERROR:', String(mountErr).slice(0,300))
// dump top-level text to see what rendered
let allText = []
const walkAll = n => { if (!n) return; if (typeof n === 'string' || typeof n === 'number') { allText.push(String(n)); return } if (Array.isArray(n)) return n.forEach(walkAll); if (n.children !== undefined) walkAll(n.children) }
walkAll(renderer.toJSON())
console.log('PAGE TEXT:', JSON.stringify(allText.join('|').slice(0, 200)))
let passed=0, failed=0
const check=(n,ok,d='')=>{passed+=!!ok;failed+=!ok;console.log(`[${ok?'PASS':'FAIL'}] ${n}${d?' — '+d:''}`)}
function flat(n,o=[]){if(!n)return o;if(typeof n==='string'||typeof n==='number'){o.push(String(n));return o}
  if(Array.isArray(n)){n.forEach(x=>flat(x,o));return o} if(n.props?.children!==undefined)flat(n.props.children,o); return o}

let newBtn = renderer.root.findAll(i=>i.type==='button'&&flat(i).join(' ').includes('New member'))[0]
if (!newBtn) {
  const labels = []
  renderer.root.findAll(i => { if (i.type === 'button') labels.push(flat(i).join(' ').slice(0,40)); return false })
  console.log('DEBUG buttons:', JSON.stringify(labels))
}
await RTR.act(async()=>{newBtn.props.onClick(); await new Promise(r=>setTimeout(r,100))})
const input = renderer.root.findAll(i=>i.type==='input')[0]

// near-duplicate slugs: planner- vs planner
for (const candidate of ['planner-', 'PLANNER', 'my agent!', '-lead', 'x']) {
  await RTR.act(async()=>{ input.props.onChange({target:{value:candidate}}); await new Promise(r=>setTimeout(r,50)) })
  const t = flat(renderer.toJSON()).join('|')
  const actionBtn = renderer.root.findAll(i => i.type==='button' && ['Create', 'Adopt & wire in'].includes(flat(i).join(' ').trim()))[0]
  const actionLabel = actionBtn ? flat(actionBtn).join(' ').trim() : ''
  const slugPreview = candidate.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'')
  if (candidate === 'planner-') {
    // trailing dash stripped -> 'planner' -> existing profile is adopted and wired
    check(`near-dupe "${candidate}" offers adoption`, actionBtn && !actionBtn.props.disabled && actionLabel === 'Adopt & wire in')
  } else if (candidate === 'PLANNER') {
    check(`case-collapsed "${candidate}" offers adoption`, actionBtn && !actionBtn.props.disabled && actionLabel === 'Adopt & wire in')
  } else if (candidate === 'my agent!') {
    check(`"my agent!" produces usable slug + enabled`, actionBtn && actionBtn.props.disabled === false,
      `slug would be "${slugPreview}"`)
  } else if (candidate === '-lead') {
    check(`leading-dash "-lead" enabled (slug cleans it)`, actionBtn && actionBtn.props.disabled === false)
  } else if (candidate === 'x') {
    check(`single char "x" rejected by length rule`, actionBtn && actionBtn.props.disabled === true)
  }
}

// Adoption must apply explicit profile edits without attempting to recreate
// the already-existing profile.
await RTR.act(async()=>{ input.props.onChange({target:{value:'planner'}}); await new Promise(r=>setTimeout(r,50)) })
const areas = renderer.root.findAll(i=>i.type==='textarea')
if (areas[0]) areas[0].props.onChange({target:{value:'adopted description'}})
if (areas[1]) areas[1].props.onChange({target:{value:'# Adopted\n'}})
const adoptBtn = renderer.root.findAll(i => i.type==='button' && flat(i).join(' ').trim() === 'Adopt & wire in')[0]
await RTR.act(async()=>{ adoptBtn?.props.onClick(); await new Promise(r=>setTimeout(r,150)) })
const calls = globalThis.__hostCalls || []
const adopted = calls.find(c => c.m === 'profiles.configure' && c.p?.name === 'planner')
check('adoption applies explicit profile edits',
  adopted?.p?.description === 'adopted description' && adopted?.p?.soul === '# Adopted\n',
  JSON.stringify(adopted?.p || null))
check('adoption does not recreate the existing profile',
  !calls.some(c => c.m === 'profiles.create' && c.p?.name === 'planner'),
  JSON.stringify(calls.filter(c => c.m.startsWith('profiles.'))))

// An inventory-only profile already exists on disk but is absent from the
// graph: it must offer adoption rather than attempting profiles.create.
await RTR.act(async()=>{ input.props.onChange({target:{value:'researcher'}}); await new Promise(r=>setTimeout(r,100)) })
const inventoryAdoptBtn = renderer.root.findAll(i => i.type === 'button' && flat(i).join(' ').trim() === 'Adopt & wire in')[0]
check('inventory-only duplicate offers adoption',
  !!inventoryAdoptBtn && inventoryAdoptBtn.props.disabled === false)

// New-bot flow: the clone source comes from Hermes' profile inventory,
// including profiles that are not graph members, and is passed to the canonical
// profiles.create RPC as clone_from.
await RTR.act(async()=>{ input.props.onChange({target:{value:'new-bot'}}); await new Promise(r=>setTimeout(r,100)) })
const selects = renderer.root.findAll(i => i.type === 'select')
const cloneSelect = selects[1]
check('new-bot loads the canonical profile inventory',
  (globalThis.__hostCalls || []).some(c => c.m === 'profiles.list' && c.p?.include_sessions === false),
  JSON.stringify((globalThis.__hostCalls || []).filter(c => c.m === 'profiles.list')))
await RTR.act(async()=>{ cloneSelect?.props.onChange({target:{value:'researcher'}}); await new Promise(r=>setTimeout(r,100)) })
const createBtn = renderer.root.findAll(i => i.type === 'button' && flat(i).join(' ').trim() === 'Create')[0]
check('new-bot create remains enabled with clone source', !!createBtn && createBtn.props.disabled === false)
await RTR.act(async()=>{ createBtn?.props.onClick(); await new Promise(r=>setTimeout(r,250)) })
const cloneCreate = (globalThis.__hostCalls || []).find(c => c.m === 'profiles.create' && c.p?.name === 'new-bot')
check('new-bot creation passes clone_from',
  cloneCreate?.p?.clone_from === 'researcher',
  JSON.stringify(cloneCreate?.p || null))

console.log(`CREATE-DIALOG PROBE: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
