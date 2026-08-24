"""Fleet Graph plugin — dashboard backend API.

Mounted at /api/plugins/fleet-graph/ by the dashboard plugin system.
Thin FastAPI wrapper around fleet_graph_core (the SSOT module shared with
the fleet-msg CLI). All reads/writes go through the same code paths the CLI
uses, so the desktop UI, the CLI, and the bots can never drift.

Extensions over the original surface:
- Per-profile unread-inbox watermarks (mark-read, unread counts) — a
  lightweight file-based state so "show read status on the badge" works
  without a DB schema change.
- /sessions/tail — a lightweight per-profile activity snapshot (latest
  session, message preview, tool in flight) so the graph canvas can render
  "this bot is working" without the UI holding a live gateway socket per bot.
"""
from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path
from typing import Optional

import yaml
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

# core module lives one level up from dashboard/
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
from fleet_graph_core import (  # noqa: E402
    DEFAULT_PROFILE, FLEET_HOME, GraphError, can_communicate, chain,
    describe, discover_missing_profiles, graph_node_for_profile,
    import_existing_profiles, load_graph, load_metadata, load_relations,
    normalize_relations, resolve_profile, save_graph,
)

HERMES = FLEET_HOME
INBOX_DIR = Path(os.environ.get("FLEET_INBOX_DIR", str(HERMES / "fleet-inbox"))).expanduser()
PROFILES_DIR = Path(os.environ.get("FLEET_PROFILES_DIR", str(HERMES / "profiles"))).expanduser()
WATERMARK_DIR = INBOX_DIR / ".read"

router = APIRouter()


class NodeUpdate(BaseModel):
    supervisor: str | None = None
    subordinates: list[str] | None = None
    peers: list[str] | None = None


class GraphUpdate(BaseModel):
    nodes: dict[str, NodeUpdate]
    relations: dict[str, list[str]] | None = None


class RelationsUpdate(BaseModel):
    relations: dict[str, list[str]]


class SimulateSend(BaseModel):
    sender: str
    recipient: str


def _known_profiles() -> list[str]:
    if not PROFILES_DIR.is_dir():
        # fresh install / nuked dir: the default profile always exists
        return [DEFAULT_PROFILE]
    names = sorted(p.name for p in PROFILES_DIR.iterdir() if p.is_dir())
    return [DEFAULT_PROFILE] + [n for n in names if n != DEFAULT_PROFILE]


def _profile_dir(name: str) -> Path | None:
    """Directory holding a profile's files, after configured alias resolution."""
    # path-safety gate: only plain single path components may pass.
    # Blocks '..', '.', embedded slashes/backslashes, and absolute paths.
    if not name or name != os.path.basename(name) or name in (".", ".."):
        return None
    if len(name.encode("utf-8", "surrogatepass")) > 255:
        return None  # longer than any legal path component -> cannot exist
    try:
        canonical = resolve_profile(name)
        if (not canonical or canonical != os.path.basename(canonical) or
                canonical in (".", "..") or
                len(canonical.encode("utf-8", "surrogatepass")) > 255):
            return None
        if canonical == DEFAULT_PROFILE:
            return HERMES
        d = PROFILES_DIR / canonical
        if d.is_dir():
            return d
        return None
    except OSError:
        return None  # ENAMETOOLONG / permission / etc. — treat as not found


def _read_yaml(path: Path) -> dict:
    try:
        return yaml.safe_load(path.read_text()) or {}
    except Exception:
        return {}


def _profile_meta(name: str) -> dict:
    """Display + runtime metadata for one profile. Never raises."""
    meta = {"title": "", "description": "", "color": "", "shape": "",
            "model": "", "provider": "", "toolsets": [], "has_avatar": False}
    pdir = _profile_dir(name)
    if not pdir:
        return meta

    if resolve_profile(name) == DEFAULT_PROFILE:
        meta["title"] = "Orchestrator"

    pdata = _read_yaml(pdir / "profile.yaml")
    meta["description"] = str(pdata.get("description") or "").strip()
    bots = ((pdata.get("ui_meta") or {}).get("hermes-bots") or {})
    meta["title"] = meta["title"] or str(bots.get("title") or "").strip()
    meta["color"] = str(bots.get("color") or "").strip()
    meta["shape"] = str(bots.get("shape") or "").strip()

    cfg = _read_yaml(pdir / "config.yaml")
    model = cfg.get("model") or {}
    meta["model"] = str(model.get("default") or "")
    meta["provider"] = str(model.get("provider") or "")
    ts = cfg.get("toolsets")
    if isinstance(ts, list):
        meta["toolsets"] = [str(t) for t in ts]

    assets = pdir / "assets"
    meta["has_avatar"] = any(
        (assets / f"avatar.{ext}").is_file() for ext in ("png", "jpg", "webp")
    ) if assets.is_dir() else False
    return meta


_CAPABILITY_STOPWORDS = {
    # generic words that carry no routing signal in ANY language/domain
    "agent", "bot", "assistant", "ai", "the", "a", "an", "for", "and", "with",
    "you", "your", "persistent", "named", "profile", "own", "memory", "skills",
    "session", "history", "keeps", "keep", "specialized", "specialist",
    "are", "was", "his", "her", "its", "their", "this", "that", "these",
    "those", "from", "into", "onto", "who", "whom", "which", "what", "when",
    "soul", "persona", "mission", "role", "officer", "operator",
}


def _capability_summary(name: str) -> dict:
    """Derive what this bot is GOOD AT from files every profile already has.

    Profile-agnostic by construction: no names, domains, or roles are
    hardcoded. Sources, in priority order:
      1. profile.yaml `description` (curated by the operator)
      2. SOUL.md first heading + first 'You are ...' sentence (persona line)
      3. enabled toolsets from config.yaml (what it can actually DO)

    The result feeds the fleet roster so any bot can decide whether a task
    belongs to a specialist.
    """
    pdir = _profile_dir(name)
    if not pdir:
        return {"name": name, "title": "", "summary": "", "keywords": [],
                "toolsets": []}

    meta = _profile_meta(name)
    summary = meta.get("description") or ""

    # SOUL.md: first markdown heading is the persona tagline
    # (e.g. "# Ops Bot — Example Role"); the first "You are" sentence
    # is the mission statement. Both exist on essentially every persona.
    soul_headline = ""
    soul_mission = ""
    soul_path = pdir / "SOUL.md"
    if soul_path.is_file():
        try:
            for line in soul_path.read_text().splitlines():
                s = line.strip()
                if not soul_headline and s.startswith("#"):
                    soul_headline = s.lstrip("# ").strip()
                low = s.lower()
                if not soul_mission and low.startswith("you are"):
                    # first sentence only
                    soul_mission = s.split(". ")[0].rstrip(".")\
                        .replace("**", "").strip()
                if soul_headline and soul_mission:
                    break
        except Exception:
            pass
    if not summary or summary.lower().startswith("ai ofm"):
        # generic operator description — the SOUL mission line is sharper
        if soul_mission:
            summary = f"{soul_mission}. {summary}".strip(". ")

    # keywords: informative words from headline + mission + description,
    # minus generic filler — used by other bots for lightweight matching.
    text = " ".join([soul_headline, soul_mission, meta.get("description") or ""])
    words = []
    for w in text.replace("—", " ").replace("-", " ")\
                 .replace("/", " ").replace(",", " ").split():
        w2 = "".join(c for c in w.lower() if c.isalnum())
        if len(w2) >= 3 and w2 not in _CAPABILITY_STOPWORDS and w2 not in words:
            words.append(w2)
    if name != "default" and name not in words:
        words.append(name)  # own name is always a routing keyword

    return {
        "name": name,
        "title": meta.get("title") or (soul_headline.split("—")[0].strip()
                                       .replace("Soul:", "").strip()
                                       if soul_headline else ""),
        "headline": soul_headline,
        "summary": summary[:300],
        "keywords": words[:24],
        "toolsets": meta.get("toolsets") or [],
    }


@router.get("/roster")
def roster():
    """The fleet capability roster: what every bot is FOR, derived from its
    own profile files. This is what lets any agent answer 'should this task
    go to a specialist?' without hardcoded knowledge of THIS fleet."""
    out = {}
    for name in _known_profiles():
        try:
            out[name] = _capability_summary(name)
        except Exception:
            continue
    return {"roster": out}


# ── semantic matching over the roster ──────────────────────────────
# Local onnx embeddings via fastembed (already in the agent venv) — no API
# calls, no cost. The model downloads once (~0.6 GB) on first use, then the
# index rebuilds lazily only when any profile's capability doc changes.

_SEMANTIC_MODEL = "mixedbread-ai/mxbai-embed-large-v1"
_semantic_cache: dict = {"mtime": None, "names": [], "matrix": None, "model": None}


def _capability_doc_text(cap: dict) -> str:
    """The text embedded per bot. Keywords + summary + title give the model
    both the curated persona line and concrete routing vocabulary. Toolsets
    are appended so 'what it can actually act through' is part of the signal
    (a bot with discord_admin IS the discord one, regardless of prose)."""
    return " ".join(filter(None, [
        cap.get("title") or "",
        cap.get("summary") or "",
        "Keywords:",
        ", ".join(cap.get("keywords") or []),
        "Tools:",
        ", ".join(cap.get("toolsets") or []),
    ]))


def _semantic_index():
    """Lazily build (and cache) the roster embedding matrix. Rebuilds when
    any profile's SOUL.md / profile.yaml mtime changes."""
    roster = {}
    mtimes = {}
    for name in _known_profiles():
        try:
            cap = _capability_summary(name)
            roster[name] = cap
            pdir = _profile_dir(name)
            if pdir:
                for f in (pdir / "SOUL.md", pdir / "profile.yaml"):
                    if f.is_file():
                        mtimes[f"{name}:{f.name}"] = f.stat().st_mtime
        except Exception:
            continue

    if _semantic_cache["mtime"] == mtimes and _semantic_cache["matrix"] is not None:
        return _semantic_cache

    try:
        from fastembed import TextEmbedding
        import numpy as np
        model = (_semantic_cache["model"]
                 or TextEmbedding(_SEMANTIC_MODEL))
        names = sorted(roster)
        docs = [_capability_doc_text(roster[n]) for n in names]
        matrix = np.array(list(model.embed(docs))) if docs else None
        # normalize so cosine similarity == dot product
        if matrix is not None and len(matrix):
            norms = np.linalg.norm(matrix, axis=1, keepdims=True)
            norms[norms == 0] = 1
            matrix = matrix / norms
        _semantic_cache.update({
            "mtime": mtimes, "names": names,
            "matrix": matrix, "model": model, "roster": roster,
        })
    except Exception as e:
        _semantic_cache["error"] = str(e)

    return _semantic_cache


@router.get("/match")
def match(q: str, top: int = 3):
    """Semantic specialist matching: embed the query task and rank the fleet
    by capability similarity. Returns top-N {name, title, summary, score}.
    Falls back with 503 if the embedding stack is unavailable."""
    import numpy as np
    idx = _semantic_index()
    matrix = idx.get("matrix")
    names = idx.get("names") or []
    if not q.strip() or matrix is None or not len(names):
        raise HTTPException(503, f"semantic index unavailable: {idx.get('error') or 'empty roster'}")
    try:
        model = idx["model"]
        qv = np.array(list(model.embed([q]))[0])
        nrm = np.linalg.norm(qv)
        if nrm:
            qv = qv / nrm
        sims = matrix @ qv
    except Exception as e:
        raise HTTPException(503, f"embedding failed: {e}")
    ranked = sorted(zip(names, sims.tolist()), key=lambda x: -x[1])[: max(1, min(int(top), 10))]
    rdata = idx.get("roster") or {}
    return {
        "query": q,
        "matches": [
            {
                "name": n,
                "title": (rdata.get(n) or {}).get("title", ""),
                "summary": (rdata.get(n) or {}).get("summary", ""),
                "score": round(float(s), 4),
            }
            for n, s in ranked
        ],
    }


def _inbox_file(name: str) -> Path:
    return INBOX_DIR / f"{name}.jsonl"


def _recent_traffic(window_s: int = 300) -> list[dict]:
    """Inter-agent messages across ALL inboxes within the last window.

    Returns newest-first [{from, to, ts_epoch, type}]. This is the data
    behind the discussion-glow: an edge (A,B) lights up when a message
    between them landed recently."""
    import time
    if not INBOX_DIR.is_dir():
        return []
    cutoff = time.time() - max(30, int(window_s))
    out = []
    for f in INBOX_DIR.glob("*.jsonl"):
        to_name = f.stem
        try:
            for line in f.read_text().splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                ts = _parse_ts(rec.get("ts") or "")
                if ts and ts >= cutoff:
                    out.append({
                        "from": rec.get("from"),
                        "to": to_name,
                        "ts": ts,
                        "type": rec.get("type"),
                    })
        except Exception:
            continue
    out.sort(key=lambda r: r["ts"], reverse=True)
    return out


@router.get("/traffic")
def traffic(window: int = 300):
    """Recent inter-agent messages (default last 5 min) for edge glow."""
    return {"messages": _recent_traffic(window)}


# ── send a fleet message from the UI ───────────────────────────────
class FleetSend(BaseModel):
    to: str
    text: str
    kind: str = "talk"  # talk | delegate | supervisor
    # Optional explicit recipient for the `talk` frame when the target has
    # several peers — the operator's picker choice. Ignored for delegate /
    # supervisor (those directions are resolved from the graph). Validated
    # against the target's peer list so it can't spoof an edge.
    recipient: str | None = None


# The only frames the FLEET-TALK prompt section knows how to resolve. Anything
# else would land in an inbox as a frame no bot can interpret — reject early.
_SEND_KINDS = {"talk", "delegate", "supervisor"}


@router.post("/send")
def fleet_send(msg: FleetSend):
    """Send an inter-bot message through the sanctioned channel (same code
    path as the fleet-msg CLI): validates the edge against the live graph,
    appends to the target's inbox. kind drives the message header so the
    receiving bot knows the conversational frame:
      talk       — peer-to-peer conversation
      delegate   — task handoff downward (to a subordinate)
      supervisor — report/escalation upward (to a supervisor)
    Delivery is inbox-only by design: the receiving bot drains its inbox on
    its routine; --deliver-style live turns are NOT triggered from UI clicks."""
    import datetime as _dt

    def _now_iso() -> str:
        return _dt.datetime.now(_dt.timezone.utc).isoformat()

    # Contract guards first: an empty message or an unknown frame is never a
    # valid send, regardless of graph state.
    if not msg.text.strip():
        raise HTTPException(422, "message text must not be empty")
    if msg.kind not in _SEND_KINDS:
        raise HTTPException(422, f"unknown frame '{msg.kind}' — expected one of: {', '.join(sorted(_SEND_KINDS))}")

    try:
        graph = load_graph()
        relations = load_relations()
    except GraphError as e:
        raise HTTPException(500, f"fleet graph unusable: {e}")

    recipient, text = DEFAULT_PROFILE, msg.text.strip()
    # 'to' names the TARGET bot; sender is resolved from the relationship:
    # delegate/supervisor imply direction, so we compute who talks to whom
    # from the graph rather than trusting the client.
    target = msg.to.strip()
    tdir = _profile_dir(target)
    if not tdir:
        raise HTTPException(404, f"profile '{target}' not found")

    if msg.kind == "delegate":
        # operator delegating work TO this bot: sender is the orchestrator
        sender_name = graph_node_for_profile(DEFAULT_PROFILE, graph)
        if not sender_name:
            raise HTTPException(
                422,
                "the default profile is not represented in the graph — "
                "add it directly or configure _meta.profile_aliases",
            )
        recipient = target
        ok, why = can_communicate(graph, sender_name, target, relations)
    elif msg.kind == "supervisor":
        # operator speaking AS this bot upward: find its supervisor
        sup = graph.get(target, {}).get("supervisor")
        if not sup:
            raise HTTPException(422, f"'{target}' has no supervisor to escalate to")
        sender_name, recipient = target, sup
        ok, why = can_communicate(graph, sender_name, recipient, relations)
    else:  # talk — operator relays a peer conversation opener from this bot
        peers = [p for p in relations.get(target, [])]
        if not peers:
            raise HTTPException(422, f"'{target}' has no peer relations to talk to")
        # Honor the operator's explicit recipient pick when the target has
        # several peers — but only if it is one of the target's real peers,
        # so the picker can never fabricate an edge the graph doesn't allow.
        wanted = (msg.recipient or "").strip()
        if wanted and wanted not in peers:
            raise HTTPException(422, f"'{wanted}' is not a peer of '{target}'")
        sender_name, recipient = target, (wanted or peers[0])
        ok, why = can_communicate(graph, sender_name, recipient, relations)

    if not ok:
        raise HTTPException(422, f"edge refused: {why}")

    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    inbox = INBOX_DIR / f"{recipient}.jsonl"
    rec = {
        "ts": _now_iso(),
        "from": sender_name,
        "type": msg.kind,
        "frame": msg.kind,
        "summary": msg.text[:500],
    }
    with open(inbox, "a") as f:
        f.write(json.dumps(rec) + "\n")

    return {
        "ok": True, "edge": why,
        "sender": sender_name, "recipient": recipient,
        "frame": msg.kind, "hint": (
            f"{recipient} will see this framed as {msg.kind} from {sender_name}. "
            f"It decides to answer coworkers, invoke its supervisor, or delegate "
            f"based on the initiative ladder in its next session."
        ),
    }


def _read_inbox(name: str) -> list[dict]:
    """Raw message records for a profile's inbox, oldest-first."""
    f = _inbox_file(name)
    if not f.exists():
        return []
    out = []
    for line in f.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def _watermark_file(name: str) -> Path:
    try:
        WATERMARK_DIR.mkdir(parents=True, exist_ok=True)
    except (OSError, FileExistsError):
        # .read path occupied by a file / unwritable — watermarking degrades
        # to no-op; badge math still works off inbox totals.
        pass
    return WATERMARK_DIR / f"{name}.json"


def _read_watermark(name: str) -> dict:
    """Last-read pointer for a profile's inbox.

    {last_read_ts, count_at_read} — count_at_read is what the badge was
    cleared at; a new message after this grows `unread` again."""
    f = _watermark_file(name)
    if not f.exists():
        return {"last_read_ts": None, "count_at_read": 0}
    try:
        return json.loads(f.read_text())
    except Exception:
        return {"last_read_ts": None, "count_at_read": 0}


def _write_watermark(name: str, wm: dict) -> None:
    f = _watermark_file(name)
    try:
        f.write_text(json.dumps(wm))
    except Exception:
        pass


def _inbox_counts() -> dict[str, int]:
    counts = {}
    if INBOX_DIR.is_dir():
        for f in INBOX_DIR.glob("*.jsonl"):
            try:
                counts[f.stem] = sum(1 for line in f.read_text().splitlines() if line.strip())
            except Exception:
                counts[f.stem] = 0
    return counts


def _unread_counts() -> dict[str, int]:
    """Per-profile unread = total - count_at_read (clamped to 0)."""
    totals = _inbox_counts()
    out: dict[str, int] = {}
    for name, total in totals.items():
        wm = _read_watermark(name)
        at_read = int(wm.get("count_at_read") or 0)
        out[name] = max(0, total - at_read)
    return out


def _depths(graph: dict) -> dict[str, int]:
    depths = {}
    for start in graph:
        depth, seen, cur = 0, set(), start
        while graph.get(cur, {}).get("supervisor") and cur not in seen:
            seen.add(cur)
            cur = graph[cur]["supervisor"]
            depth += 1
        depths[start] = depth
    return depths


def _latest_session(name: str) -> dict | None:
    """Lightweight per-profile activity snapshot via session.list.

    Returns the most recent writable session for the profile with a short
    preview, or None if the profile has no sessions / its state.db is
    unavailable. This is what the graph canvas reads to paint
    'this bot is thinking / running X right now'."""
    pdir = _profile_dir(name)
    if not pdir:
        return None
    db_path = pdir / "state.db"
    if not db_path.is_file():
        return None
    try:
        from hermes_state import SessionDB
    except Exception:
        return None
    try:
        db = SessionDB(db_path=db_path)
        try:
            sessions = db.list_sessions_rich(
                source=None, limit=1, order_by_last_active=True,
                compact_rows=True, include_hidden=True,
            )
            if not sessions:
                return None
            row = sessions[0]
            # Resolve compression-continuation tips so the canvas sees the
            # LIVE conversation, not a compressed root. list_sessions_rich
            # projects tips automatically, but we re-resolve the full chain
            # to get the true live session id + status.
            tip_id = row.get("id") or row.get("session_id")
            root_id = row.get("_lineage_root_id")
            sid = tip_id or root_id
            # status tells us whether the bot is mid-turn (interrupted / tool in flight)
            statuses = db.session_lifecycle_statuses([sid]) if sid else {}
            status = statuses.get(sid, "") if sid else ""
            last_active = int(row.get("last_active") or row.get("started_at") or 0)
            # Freshness-aware reclassification: 'interrupted' means "last row
            # is a user/tool turn — the agent never answered". Correct for an
            # abandoned session, WRONG for a live one where the user just
            # spoke and the reply is streaming. If the session was touched in
            # the last 3 minutes, report 'active' instead.
            if status == "interrupted" and last_active:
                age_s = max(0, _now_epoch() - last_active)
                if age_s < 180:
                    status = "active"
            return {
                "session_id": sid,
                "root_id": root_id,
                "resolved_id": tip_id,
                "title": row.get("title") or "",
                "preview": _truncate(str(row.get("preview") or ""), 200),
                "message_count": int(row.get("message_count") or 0),
                "unread": int(row.get("unread") or 0),
                "status": status,
                "last_active": last_active,
                "started_at": int(row.get("started_at") or 0),
                "source": row.get("source") or "",
            }
        finally:
            try:
                db.close()
            except Exception:
                pass
    except Exception:
        return None


@router.get("/graph")
def get_graph():
    try:
        return {"graph": describe(load_graph()), "profiles": _known_profiles()}
    except GraphError as e:
        raise HTTPException(500, str(e))


@router.get("/overview")
def overview(light: str = ""):
    """One call = everything the main view paints: topology + display meta
    + runtime config + inbox pressure + chain depth + unassigned profiles
    + unread counts.

    Pass ?light=1 (or true) to skip the per-profile state.db session lookups —
    the fast poll path when the UI only needs badges and topology."""
    try:
        graph = describe(load_graph())
    except GraphError as e:
        raise HTTPException(500, str(e))
    relations = load_relations()
    known = _known_profiles()
    counts = _inbox_counts()
    unread = _unread_counts()
    depths = _depths(graph)
    light_mode = str(light).lower() in ("1", "true", "yes")
    # A graph alias and its canonical profile are one entity. Emit the graph
    # node plus only canonical profiles not already represented by an alias.
    represented_profiles = {resolve_profile(name) for name in graph}
    extra_profiles = [name for name in known if name not in represented_profiles]
    nodes = {}
    for name in dict.fromkeys(list(graph.keys()) + extra_profiles):
        node = graph.get(name, {"supervisor": None, "subordinates": []})
        nodes[name] = {
            "profile": resolve_profile(name),
            "supervisor": node.get("supervisor"),
            "subordinates": sorted(node.get("subordinates", [])),
            "peers": relations.get(name, []),
            "depth": depths.get(name, 0) if name in graph else None,
            "inbox": counts.get(name, 0),
            "unread": unread.get(name, 0),
            "in_graph": name in graph,
            "latest_session": None if light_mode else _latest_session(name),
            **_profile_meta(name),
        }
    return {"nodes": nodes}


@router.get("/graph/summary")
def graph_summary():
    """Cheap header-strip payload: node count, edge count (supervisor links +
    peer pairs), and a status histogram over each bot's latest session."""
    try:
        graph = describe(load_graph())
        relations = load_relations()
    except GraphError as e:
        raise HTTPException(500, str(e))
    edges = sum(len(v.get("subordinates") or []) for v in graph.values())
    peer_pairs = (sum(len(v) for v in relations.values()) // 2) if isinstance(relations, dict) else 0
    represented_profiles = {resolve_profile(name) for name in graph}
    known_all = dict.fromkeys(list(graph.keys()) + [
        name for name in _known_profiles() if name not in represented_profiles
    ])
    by_status = {}
    for name in known_all:
        ls = _latest_session(name)
        st = (ls or {}).get("status") or "no-session"
        by_status[st] = by_status.get(st, 0) + 1
    return {"nodes": len(known_all), "edges": edges + peer_pairs, "by_status": by_status}


@router.get("/avatar/{name}")
def get_avatar(name: str):
    """Profile avatar as a data URL — pets and uploaded images live in the
    profile asset store (assets/avatar.*), never in profile.yaml."""
    pdir = _profile_dir(name)
    if pdir:
        assets = pdir / "assets"
        if assets.is_dir():
            for ext, mime in (("png", "image/png"), ("jpg", "image/jpeg"), ("webp", "image/webp")):
                f = assets / f"avatar.{ext}"
                if f.is_file():
                    blob = f.read_bytes()
                    return {"found": True,
                            "data": f"data:{mime};base64,{base64.b64encode(blob).decode('ascii')}"}
    return {"found": False}


@router.get("/soul/{name}")
def get_soul(name: str):
    pdir = _profile_dir(name)
    if not pdir:
        raise HTTPException(404, f"profile '{name}' not found")
    soul = pdir / "SOUL.md"
    return {"name": name, "soul": soul.read_text() if soul.is_file() else ""}


@router.put("/soul/{name}")
def put_soul(name: str, body: dict):
    """Replace a profile's SOUL.md. The default profile is off-limits."""
    # Write guard is resolved-path based so configured aliases cannot bypass it.
    if _profile_dir(name) == HERMES:
        raise HTTPException(403, "the default profile's SOUL is not editable here")
    pdir = _profile_dir(name)
    if not pdir:
        raise HTTPException(404, f"profile '{name}' not found")
    text = str(body.get("soul") or "")
    if not text.strip():
        raise HTTPException(422, "soul must not be empty")
    (pdir / "SOUL.md").write_text(text)
    return {"ok": True, "name": name, "bytes": len(text)}


@router.put("/graph")
def put_graph(update: GraphUpdate):
    """Replace the graph (and optionally relations) from the UI editor."""
    raw = {}
    for name, node in update.nodes.items():
        entry = {}
        if node.supervisor:
            entry["supervisor"] = node.supervisor
        if node.subordinates is not None:
            entry["subordinates"] = node.subordinates
        raw[name] = entry
    try:
        saved = save_graph(raw, relations=update.relations if update.relations is not None else load_relations())
        return {"ok": True, "graph": describe(saved, load_relations())}
    except GraphError as e:
        raise HTTPException(422, str(e))


class ImportProfiles(BaseModel):
    profiles: list[str]
    supervisor: str | None = None


@router.get("/profiles/discover")
def discover_profiles():
    """On-disk Hermes profile directories not yet wired into the graph.

    Delegates to the SSOT core so the CLI and dashboard can never drift.
    Explicit-import only (no startup auto-scan), so fleet_graph.yaml stays
    the sole source of truth for graph structure. Display metadata comes
    from each profile's own files (profile.yaml / SOUL.md / config.yaml).
    """
    try:
        graph = describe(load_graph())
    except GraphError as e:
        raise HTTPException(500, str(e))
    represented = {resolve_profile(name) for name in graph}
    discovered = []
    for entry in discover_missing_profiles():
        name = entry["name"]
        if name in represented or name == DEFAULT_PROFILE:
            continue
        meta = _profile_meta(name)
        cap = _capability_summary(name)
        discovered.append({
            "name": name,
            "title": meta.get("title") or cap.get("headline") or entry.get("title") or name,
            "description": cap.get("summary") or meta.get("description") or entry.get("description") or "",
            "model": meta.get("model") or "",
            "provider": meta.get("provider") or "",
            "toolsets": meta.get("toolsets") or [],
        })
    return {"discovered": discovered}


@router.post("/profiles/import")
def import_profiles(batch: ImportProfiles):
    """Wire existing on-disk profiles into the graph.

    Collision policy (ruled): a requested profile that is already a graph
    node is skipped with a warning rather than overwritten. Each imported
    node starts unassigned unless a supervisor is supplied; the operator
    can re-wire in the editor afterwards.
    """
    try:
        result = import_existing_profiles(batch.profiles, batch.supervisor)
    except GraphError as e:
        raise HTTPException(422, str(e))
    return {"ok": True, **result}


@router.get("/relations")
def get_relations():
    try:
        return {"relations": load_relations()}
    except GraphError as e:
        raise HTTPException(500, str(e))


@router.put("/relations")
def put_relations(update: RelationsUpdate):
    """Replace the peer-relations map. Validated against the current graph."""
    try:
        graph = load_graph()
        normalized = normalize_relations(update.relations, graph)
        save_graph(graph, relations=normalized)
        return {"ok": True, "relations": normalized}
    except GraphError as e:
        raise HTTPException(422, str(e))


@router.post("/simulate")
def simulate(send: SimulateSend):
    """Check whether a send would be allowed, and its routing chain."""
    graph = load_graph()
    relations = load_relations()
    ok, why = can_communicate(graph, send.sender, send.recipient, relations)
    return {"ok": ok, "reason": why,
            "chain": None if why == "peer" else chain(graph, send.sender, send.recipient)}


@router.get("/inbox/{profile}")
def get_inbox(profile: str):
    return {"profile": profile, "messages": _read_inbox(profile)}


@router.delete("/inbox/{profile}")
def drain_inbox(profile: str):
    inbox = _inbox_file(profile)
    if inbox.exists():
        inbox.unlink()
    # clearing the inbox clears the watermark too
    wm = _watermark_file(profile)
    if wm.exists():
        wm.unlink()
    return {"ok": True, "profile": profile}


@router.post("/inbox/{profile}/read")
def mark_inbox_read(profile: str, body: dict = None):
    """Mark the profile's inbox as read — advances the watermark to the
    current message count (and optionally to a specific timestamp or count).

    Body:
      ts:   epoch-ms — treat every message sent before/at this time as read.
      count: int    — treat the first N messages as read (absolute count).
    With no body, marks everything currently present as read."""
    msgs = _read_inbox(profile)
    total = len(msgs)
    try:
        if body and "count" in body and body["count"] is not None:
            at = max(0, min(int(body["count"]), total))
        elif body and "ts" in body:
            # messages carry ISO ts; count those <= the given epoch-ms
            cut = float(body["ts"]) / 1000.0
            at = 0
            for m in msgs:
                try:
                    if _parse_ts(m.get("ts")) <= cut:
                        at += 1
                except Exception:
                    at += 1
        else:
            at = total
    except (TypeError, ValueError):
        raise HTTPException(422, "mark-read body 'count' must be an integer and 'ts' an epoch-ms number")
    wm = {"last_read_ts": _now_iso(), "count_at_read": at}
    _write_watermark(profile, wm)
    return {"ok": True, "profile": profile, "count_at_read": at, "total": total}


@router.get("/sessions/{name}/messages")
def session_messages(name: str, limit: int = Query(default=30, ge=1, le=100)):
    """The actual transcript tail of a bot's most recent session.

    Returns the last `limit` messages (oldest→newest) with role + text
    preview. This is what the canvas detail drawer renders as a live
    activity tail; poll it every few seconds while open."""
    ls = _latest_session(name)
    if not ls:
        return {"profile": name, "session_id": None, "messages": []}
    pdir = _profile_dir(name)
    db_path = (pdir / "state.db") if pdir else None
    if not db_path or not db_path.is_file():
        return {"profile": name, "session_id": ls.get("session_id"), "messages": []}
    try:
        from hermes_state import SessionDB
        db = SessionDB(db_path=db_path)
        try:
            rows = db.get_messages(
                ls["session_id"], include_compacted=True,
                limit=max(1, min(int(limit), 100)), latest=True,
            )
        finally:
            db.close()
    except Exception:
        return {"profile": name, "session_id": ls.get("session_id"), "messages": []}

    def _text_of(row):
        # message payloads are JSON strings with a content field; fall back
        # to str() for anything unusual so the tail never renders blank.
        raw = row.get("content") or ""
        try:
            data = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            return _truncate(str(raw), 240)
        if isinstance(data, dict):
            for key in ("text", "content", "summary"):
                if isinstance(data.get(key), str) and data[key].strip():
                    return _truncate(data[key], 240)
            return _truncate(json.dumps(data), 240)
        if isinstance(data, list):
            parts = []
            for item in data:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            joined = "\n".join(p for p in parts if p.strip())
            return _truncate(joined or json.dumps(data), 240)
        return _truncate(str(data), 240)

    msgs = [
        {
            "id": r.get("id"),
            "role": r.get("role"),
            "text": _text_of(r),
            "ts": r.get("ts") or r.get("created_at"),
        }
        for r in rows
    ]
    return {"profile": name, "session_id": ls.get("session_id"), "messages": msgs}


@router.get("/sessions/tail")
def sessions_tail(profile: Optional[str] = None):
    """Lightweight per-profile activity snapshot. Returns nodes already in
    the overview with their latest_session field refreshed and their current
    unread/inbox counts — a single call to paint fleet activity without the
    caller holding N live sockets.

    Pass profile=X to scope to one bot; omit for all fleet members."""
    try:
        graph = describe(load_graph())
    except GraphError as e:
        raise HTTPException(500, str(e))
    targets = [profile] if profile else list(graph.keys())
    out = {}
    for name in targets:
        node = graph.get(name, {"supervisor": None, "subordinates": []})
        try:
            f = _inbox_file(name)
            total = sum(1 for line in f.read_text().splitlines() if line.strip()) if f.exists() else 0
            wm = _read_watermark(name)
        except OSError:
            # name too long for the filesystem / permission — treat as no inbox
            total, wm = 0, {}
        out[name] = {
            "latest_session": _latest_session(name),
            "inbox": total,
            "unread": max(0, total - int(wm.get("count_at_read") or 0)),
            "last_read_ts": wm.get("last_read_ts"),
        }
    return {"sessions": out}


# ── tiny timestamp helpers (no dependency on the full hermes_cli time path) ──
import datetime


def _now_epoch() -> float:
    return datetime.datetime.now(datetime.timezone.utc).timestamp()


def _truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "\u2026"


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


_TS_FORMATS = (
    "%Y-%m-%dT%H:%M:%S.%f%z",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%fZ",
    "%Y-%m-%dT%H:%M:%SZ",
    "%Y-%m-%dT%H:%M:%S.%f",
)

def _parse_ts(ts: str) -> float:
    """Parse an ISO-8601 ts (with optional Z / offset) to epoch seconds."""
    if not ts:
        return 0.0
    s = str(ts).strip()
    try:
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        for fmt in _TS_FORMATS:
            try:
                dt = datetime.datetime.strptime(s, fmt)
                return dt.timestamp()
            except Exception:
                continue
        return 0.0
