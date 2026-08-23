// Neutral fleet fixtures shared by the frontend harnesses.
//
// Identities are limited to the five public role names: captain, planner,
// research, builder, reviewer. No real project descriptions, personas, model
// or provider names appear here. Harnesses may layer their own adversarial
// overrides on top (see the hostile harness) but must not reintroduce private
// identities or machine-bound paths.

export const CAPTAIN = 'captain'
export const PLANNER = 'planner'
export const RESEARCH = 'research'
export const BUILDER = 'builder'
export const REVIEWER = 'reviewer'

const TITLES = {
  [CAPTAIN]: 'Captain',
  [PLANNER]: 'Planner',
  [RESEARCH]: 'Research',
  [BUILDER]: 'Builder',
  [REVIEWER]: 'Reviewer',
}

// Generic node builder: field names mirror the backend /overview contract so
// fixtures stay characterization-faithful.
export function fleetNode({
  name,
  supervisor = null,
  subordinates = [],
  peers = [],
  depth = 0,
  inbox = 0,
  unread = 0,
  in_graph = true,
  has_avatar = false,
  color = '#000000',
  title,
  latest_session = null,
}) {
  return {
    supervisor,
    subordinates: [...subordinates],
    peers: [...peers],
    depth,
    inbox,
    unread,
    in_graph,
    has_avatar,
    color,
    title: title ?? TITLES[name] ?? name,
    latest_session,
  }
}

export function overviewOf(nodes) {
  return { nodes }
}

// captain -> planner -> research chain (drive/render harnesses).
export function chainOverview() {
  return overviewOf({
    [CAPTAIN]: fleetNode({
      name: CAPTAIN, subordinates: [PLANNER], depth: 0, inbox: 2, unread: 1,
      color: '#7aa2f7',
      latest_session: { session_id: 's1', title: 'Bot Chat', message_count: 12, status: 'complete', preview: 'hey' },
    }),
    [PLANNER]: fleetNode({ name: PLANNER, supervisor: CAPTAIN, subordinates: [RESEARCH], depth: 1, color: '#9ece6a' }),
    [RESEARCH]: fleetNode({
      name: RESEARCH, supervisor: PLANNER, depth: 2, inbox: 1, unread: 1,
      color: '#e0af68',
      latest_session: { session_id: 's3', title: 'Bot Chat', message_count: 2, status: 'complete', preview: 'hi' },
    }),
  })
}

// Live-tail payload matching chainOverview's leaf member.
export function chainTail() {
  return {
    profile: RESEARCH, session_id: 's3',
    messages: [
      { id: 1, role: 'user', text: 'hello' },
      { id: 2, role: 'assistant', text: 'hi there' },
    ],
  }
}

const SESSION_S1 = { session_id: 's1', title: 'Bot Chat', message_count: 3, status: 'complete' }
const SESSION_S2 = { session_id: 's2', title: 'T', message_count: 1, status: 'complete' }

// captain -> planner pair. Loop-2 defaults; loop-5 overrides counts and drops
// the captain's latest_session without changing any asserted behavior.
export function pairOverview({
  captainInbox = 1,
  captainUnread = 1,
  captainSession = SESSION_S1,
  plannerInbox = 0,
  plannerUnread = 0,
  plannerSession = SESSION_S2,
} = {}) {
  return overviewOf({
    [CAPTAIN]: fleetNode({
      name: CAPTAIN, subordinates: [PLANNER], depth: 0,
      inbox: captainInbox, unread: captainUnread, color: '#000000',
      latest_session: captainSession,
    }),
    [PLANNER]: fleetNode({
      name: PLANNER, supervisor: CAPTAIN, depth: 1,
      inbox: plannerInbox, unread: plannerUnread, color: '#111111',
      latest_session: plannerSession,
    }),
  })
}

// Deck fixture (tree harness): two-tier team plus one unassigned profile.
export function deckOverview({ nowSec = Math.floor(Date.now() / 1000) } = {}) {
  return overviewOf({
    [CAPTAIN]: fleetNode({
      name: CAPTAIN, subordinates: [PLANNER], depth: 0, inbox: 2, unread: 2, color: '#000000',
      latest_session: { session_id: 's1', title: 'Bot Chat', message_count: 3, status: 'active', last_active: nowSec - 30 },
    }),
    [PLANNER]: fleetNode({
      name: PLANNER, supervisor: CAPTAIN, depth: 1, inbox: 1, unread: 1, color: '#111111',
      latest_session: { session_id: 's2', title: 'T', message_count: 1, status: 'complete', last_active: nowSec - 90000 },
    }),
    [REVIEWER]: fleetNode({ name: REVIEWER, depth: null, in_graph: false, color: '#222222', title: '' }),
  })
}

// Roster summaries are neutral capability copy only.
export function deckRoster() {
  return {
    roster: {
      [CAPTAIN]: { name: CAPTAIN, title: TITLES[CAPTAIN], summary: 'coordinates the fleet and delegates tasks', keywords: ['delegate'] },
      [PLANNER]: { name: PLANNER, title: TITLES[PLANNER], summary: 'handles local generation jobs', keywords: ['generate'] },
    },
  }
}

// Composer fixture (message-routing harness): a multi-peer member with its own
// report plus two peers, and a peerless leaf member.
export function composerOverview() {
  return overviewOf({
    [CAPTAIN]: fleetNode({ name: CAPTAIN, subordinates: [PLANNER], depth: 0, color: '#000000' }),
    [PLANNER]: fleetNode({
      name: PLANNER, supervisor: CAPTAIN, subordinates: [REVIEWER], peers: [RESEARCH, BUILDER],
      depth: 1, color: '#111111',
    }),
    [REVIEWER]: fleetNode({ name: REVIEWER, supervisor: PLANNER, depth: 2, color: '#222222' }),
    [RESEARCH]: fleetNode({ name: RESEARCH, peers: [PLANNER], depth: 0, color: '#333333' }),
    [BUILDER]: fleetNode({ name: BUILDER, peers: [PLANNER], depth: 0, color: '#444444' }),
  })
}

export function composerRoster() {
  return {
    roster: {
      [PLANNER]: { name: PLANNER, title: TITLES[PLANNER], summary: 'multi-peer test member', keywords: [] },
      [REVIEWER]: { name: REVIEWER, title: TITLES[REVIEWER], summary: 'peerless leaf member', keywords: [] },
    },
  }
}

// Neutral request-API payloads shared by harness stubs.
export function modelOptionsFixture() {
  return { providers: [{ slug: 'provider-a', name: 'Provider A', models: ['model-1'] }] }
}

export function profileDescribeFixture() {
  return {
    skills: [{ name: 'skill-1', enabled: true, tool_count: 3 }],
    toolsets: [{ name: 'set-core', enabled: true, tool_count: 9 }],
  }
}
