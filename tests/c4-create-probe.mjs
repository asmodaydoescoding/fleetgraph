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
export const host={ request:(m,p)=>Promise.resolve(m==='profiles.describe'?{skills:[],toolsets:[]}:{providers:[]}), onEvent:()=>()=>{}, notify(o){globalThis.__n=o} }
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
export function Select({key,...props}){ const ch=props.children===undefined?[]:props.children
  const items=(Array.isArray(ch)?ch:[ch]).filter(Boolean)
  globalThis.__lastSelectItems = items.map(o=>({value:o?.props?.value,label:o?.props?.children??''}))
  return React.createElement('select',{onChange:e=>props.onChange&&props.onChange(e.target.value)},
    items.map((o,i)=>React.createElement('option',{key:i,value:o?.props?.value??''},o?.props?.children??''))) }
export { Select as SelectSdk, Select as SelectContent, Select as SelectItem, Select as SelectTrigger, Select as SelectValue }
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
mod.default.register({
  rest: p => Promise.resolve(p.startsWith('/overview') ? { nodes: {
    [CAPTAIN]: fleetNode({ name: CAPTAIN, subordinates: [], depth: 0 }),
    [PLANNER]: fleetNode({ name: PLANNER, supervisor: CAPTAIN, subordinates: [], depth: 1 }),
  }} : Promise.resolve({})),
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
  const createBtn = renderer.root.findAll(i=>i.type==='button'&&flat(i).join(' ').trim()==='Create')[0]
  const slugPreview = candidate.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'')
  if (candidate === 'planner-') {
    // trailing dash stripped -> 'planner' -> duplicate of existing
    check(`near-dupe "${candidate}" blocked`, createBtn.props.disabled === true)
  } else if (candidate === 'PLANNER') {
    check(`case-collapsed "${candidate}" blocked as dupe`, createBtn.props.disabled === true)
  } else if (candidate === 'my agent!') {
    check(`"my agent!" produces usable slug + enabled`, createBtn && createBtn.props.disabled === false,
      `slug would be "${slugPreview}"`)
  } else if (candidate === '-lead') {
    check(`leading-dash "-lead" enabled (slug cleans it)`, createBtn && createBtn.props.disabled === false)
  } else if (candidate === 'x') {
    check(`single char "x" rejected by length rule`, createBtn && createBtn.props.disabled === true)
  }
}
console.log(`CREATE-DIALOG PROBE: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
