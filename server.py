#!/usr/bin/env python3
"""AI Panel — lokalny serwer dashboardu sesji Claude Code i Codex.

Czyta lokalne pliki (sesje Claude, baza Codexa, cache kalendarza) i API OpenUsage na localhost.
Na zewnątrz tylko pobiera: publiczne strony statusu Anthropic/OpenAI i listę PR-ów przez `gh`.
Nie wysyła żadnych danych z komputera.
"""
import json
import os
import plistlib
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOME = Path.home()
ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
PORT = int(os.environ.get("AI_PANEL_PORT", "7319"))
ALLOWED_HOSTS = {"127.0.0.1:%d" % PORT, "localhost:%d" % PORT}

CLAUDE_SESSIONS = HOME / ".claude" / "sessions"
CLAUDE_PROJECTS = HOME / ".claude" / "projects"
CODEX_HOME = HOME / ".codex"
OPENUSAGE_URL = "http://127.0.0.1:6736/v1/usage"
CALENDAR_JSON = HOME / "Library" / "Caches" / "ai-panel" / "calendar.json"
# Cennik modeli z OpenUsage (USD za 1M tokenów) — ten sam, z którego liczone są sumy w nagłówkach.
PRICING_DIR = HOME / "Library" / "Application Support" / "OpenUsage" / "pricing"

# Codex nie ma procesu na wątek, więc „aktywny” = ruch w ciągu ostatnich N godzin.
CODEX_ACTIVE_HOURS = 24
OPENUSAGE_TTL = 20  # s

# Miesięczna cena abonamentu w USD, do przelicznika „ile razy abonament”.
PLAN_PRICES = {
    "claude": {"pro": 20, "max": 100, "max 5x": 100, "max 20x": 200, "team": 30},
    "codex": {"plus": 20, "pro": 200, "business": 30, "team": 30},
}

# Linki otwierające sesję w aplikacji (sprawdzone na Claude 2.1 i ChatGPT/Codex).
CLAUDE_DESKTOP_ID = re.compile(r"^local_[A-Za-z0-9-]{1,64}$")
CLAUDE_BUNDLE = "com.anthropic.claudefordesktop"
# Druga instancja Claude z Parall ma własne sesje; jej proces działa z „…/Application Support/Parall/<Nazwa>/claude-code/…”.
PARALL_EXE = re.compile(r"/Application Support/Parall/([^/]+)/claude-code/")
GH_PR = re.compile(r"^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$")
UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

CACHE_DIR = HOME / "Library" / "Caches" / "ai-panel"
USAGE_HISTORY = CACHE_DIR / "usage-history.json"
# launchd ma okrojony PATH, a gh z Homebrew leży poza nim.
GH = shutil.which("gh", path=os.environ.get("PATH", "") + ":/opt/homebrew/bin:/usr/local/bin")
STATUS_PAGES = {
    "claude": "https://status.claude.com/api/v2/summary.json",
    "codex": "https://status.openai.com/api/v2/summary.json",
}
SLOW_POLL = 120  # s — GitHub i strony statusu

STATIC_TYPES = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml"}


# ---------- narzędzia ----------

def now_ms():
    return int(time.time() * 1000)


def iso_to_ms(s):
    if not s:
        return None
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def tail_lines(path, max_bytes=768 * 1024):
    """Ostatnie linie pliku (bez wczytywania całego transkryptu)."""
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        start = max(0, size - max_bytes)
        f.seek(start)
        lines = f.read().split(b"\n")
    if start > 0:
        lines = lines[1:]
    return [l for l in lines if l.strip()]


_MD = [
    (re.compile(r"```.*?```", re.S), " "),
    (re.compile(r":::\w*(\{[^}]*\})?"), " "),  # dyrektywy Codexa, np. :::writing{...}
    (re.compile(r"`([^`]*)`"), r"\1"),
    (re.compile(r"\[([^\]]+)\]\([^)]+\)"), r"\1"),
    (re.compile(r"[*_#>]+"), ""),
    (re.compile(r"\s+"), " "),
]


def clean_text(text, limit=220):
    if not text:
        return ""
    for rx, rep in _MD:
        text = rx.sub(rep, text)
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def asks_question(text):
    return bool(text) and text.rstrip(" )\"'”").endswith("?")


class FileCache:
    """Wynik parsowania pliku trzymany do zmiany mtime/rozmiaru."""

    def __init__(self):
        self.data = {}

    def get(self, path, fn):
        try:
            st = os.stat(path)
        except OSError:
            return None
        key = (st.st_mtime_ns, st.st_size)
        hit = self.data.get(path)
        if hit and hit[0] == key:
            return hit[1]
        val = fn(path)
        self.data[path] = (key, val)
        return val


_parse_cache = FileCache()
_transcript_paths = {}


# ---------- koszt czatu ----------

class Pricing:
    """Ceny z cache OpenUsage: i/o = wejście/wyjście, cr/cw = odczyt/zapis cache, fast = mnożnik."""

    def __init__(self):
        self.loaded_at = 0
        self.tables = []

    def get(self, model):
        if time.time() - self.loaded_at > 3600:
            self.tables = []
            for name in ("litellm.json", "models_dev.json"):
                try:
                    self.tables.append(json.loads((PRICING_DIR / name).read_text())["models"])
                except (OSError, ValueError, KeyError):
                    pass
            self.loaded_at = time.time()
        base = re.sub(r"-\d{8}$", "", model or "")
        for table in self.tables:
            for key in (model, base, "anthropic/" + base, "openai/" + base):
                if key in table:
                    return table[key]
        return None


_pricing = Pricing()


class Tally:
    """Narastający koszt jednego pliku JSONL; czytamy tylko to, co dopisano od ostatniego razy."""

    def __init__(self, ino):
        self.ino, self.offset, self.rest = ino, 0, b""
        self.cost, self.unpriced, self.seen, self.model = 0.0, 0, set(), None


_tallies = {}


def tally(path, consume, markers):
    try:
        st = os.stat(path)
    except OSError:
        return None
    t = _tallies.get(path)
    if t is None or t.ino != st.st_ino or st.st_size < t.offset:
        t = _tallies[path] = Tally(st.st_ino)
    if st.st_size > t.offset:
        with open(path, "rb") as f:
            f.seek(t.offset)
            chunk = t.rest + f.read(st.st_size - t.offset)
        t.offset = st.st_size
        lines = chunk.split(b"\n")
        t.rest = lines.pop()  # niedokończona ostatnia linia — dokończymy przy następnym odczycie
        for raw in lines:
            if any(m in raw for m in markers):
                try:
                    consume(t, json.loads(raw))
                except (ValueError, TypeError, KeyError, AttributeError):
                    pass
    return t


def consume_claude(t, e):
    if e.get("type") != "assistant":
        return
    msg = e.get("message") or {}
    u, model = msg.get("usage"), msg.get("model")
    key = msg.get("id") or e.get("requestId")
    if not u or not model or model.startswith("<") or key in t.seen:
        return
    t.seen.add(key)  # Claude Code zapisuje jedną odpowiedź w kilku liniach z tym samym usage
    p = _pricing.get(model)
    if not p:
        t.unpriced += 1
        return
    cc = u.get("cache_creation") or {}
    write_1h = cc.get("ephemeral_1h_input_tokens") or 0
    write_5m = cc.get("ephemeral_5m_input_tokens", (u.get("cache_creation_input_tokens") or 0) - write_1h)
    usd = ((u.get("input_tokens") or 0) * p["i"] + (u.get("output_tokens") or 0) * p["o"]
           + (u.get("cache_read_input_tokens") or 0) * p.get("cr", p["i"])
           + write_5m * p.get("cw", p["i"]) + write_1h * 2 * p["i"]) / 1e6
    t.cost += usd * (p.get("fast", 1) if u.get("speed") == "fast" else 1)


def consume_codex(t, e):
    p_ = e.get("payload") or {}
    if e.get("type") == "turn_context":
        t.model = p_.get("model") or t.model
        return
    if e.get("type") != "token_usage_record" or p_.get("response_id") in t.seen:
        return
    t.seen.add(p_.get("response_id"))
    u, p = p_.get("usage") or {}, _pricing.get(t.model)
    if not p:
        t.unpriced += 1
        return
    cached, written = u.get("cached_input_tokens") or 0, u.get("cache_write_input_tokens") or 0
    fresh = max(0, (u.get("input_tokens") or 0) - cached - written)  # input_tokens zawiera cache
    t.cost += (fresh * p["i"] + cached * p.get("cr", p["i"]) + written * p.get("cw", p["i"])
               + (u.get("output_tokens") or 0) * p["o"]) / 1e6


def cost_of(tallies):
    tallies = [t for t in tallies if t]
    if not tallies:
        return None
    return {"usd": round(sum(t.cost for t in tallies), 2), "partial": any(t.unpriced for t in tallies)}


# ---------- Claude Code ----------

def claude_url(d):
    host_id, sid = d.get("hostSessionId") or "", d.get("sessionId") or ""
    if CLAUDE_DESKTOP_ID.match(host_id):
        return "claude://code/continue?session=" + host_id
    if UUID.match(sid):
        return "claude://resume?session=" + sid  # sesja z terminala: aplikacja ją importuje
    return None


_instances = {}


def claude_instance(pid):
    """(etykieta, bundle ID) aplikacji, do której należy sesja. Etykieta None = główny Claude."""
    if pid in _instances:
        return _instances[pid]
    try:
        exe = subprocess.run(["/bin/ps", "-o", "comm=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=2).stdout
    except (OSError, subprocess.SubprocessError):
        return None, CLAUDE_BUNDLE  # bez cache — spróbujemy następnym razem
    result = (None, CLAUDE_BUNDLE)
    m = PARALL_EXE.search(exe)
    if m:
        app = m.group(1)
        inner = re.search(r"\(([^)]+)\)", app)  # „Claude (Praca)” → „Praca”
        label, bundle = inner.group(1) if inner else app, CLAUDE_BUNDLE
        for base in (Path("/Applications"), HOME / "Applications"):
            try:
                with open(base / (app + ".app") / "Contents" / "Info.plist", "rb") as f:
                    bundle = plistlib.load(f).get("CFBundleIdentifier") or CLAUDE_BUNDLE
                break
            except (OSError, plistlib.InvalidFileException):
                continue
        result = (label, bundle)
    _instances[pid] = result
    return result


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def claude_transcript(session_id):
    path = _transcript_paths.get(session_id)
    if path and os.path.exists(path):
        return path
    hits = list(CLAUDE_PROJECTS.glob("*/%s.jsonl" % session_id))
    path = str(hits[0]) if hits else None
    _transcript_paths[session_id] = path
    return path


def parse_claude_transcript(path):
    title = None
    message = None
    for raw in reversed(tail_lines(path)):
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        t = e.get("type")
        if t in ("custom-title", "summary") and not title:
            title = e.get("customTitle") or e.get("summary")
        if message is None and t == "assistant" and not e.get("isSidechain"):
            content = (e.get("message") or {}).get("content") or []
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
            text = "\n".join(t for t in texts if t.strip())
            if text:
                message = text
        if message and title:
            break
    return {"title": title, "message": message}


def claude_cost(sid, tpath):
    markers = (b'"usage"',)
    files = [tpath] + [str(p) for p in Path(tpath).parent.joinpath(sid, "subagents").glob("*.jsonl")]
    return cost_of(tally(f, consume_claude, markers) for f in files)


def claude_sessions():
    out = []
    for f in CLAUDE_SESSIONS.glob("*.json"):
        try:
            d = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        pid = d.get("pid")
        if not isinstance(pid, int) or not pid_alive(pid) or d.get("spare"):
            continue
        sid = d.get("sessionId")
        tpath = claude_transcript(sid) if sid else None
        if not tpath:
            continue  # sesja bez żadnej wymiany — nic do pokazania
        parsed = _parse_cache.get(tpath, parse_claude_transcript) or {}
        raw_message = parsed.get("message") or ""
        status = d.get("status")
        waiting_for = d.get("waitingFor")
        if waiting_for or status not in ("busy", "idle", None):
            state, detail = "waiting", waiting_for or status
        elif status == "busy":
            state, detail = "working", None
        elif asks_question(raw_message):
            state, detail = "waiting", "pytanie"
        else:
            state, detail = "done", None
        cwd = d.get("cwd") or ""
        out.append({
            "id": sid,
            "name": d.get("name") or parsed.get("title") or os.path.basename(cwd) or "sesja",
            "project": os.path.basename(cwd.rstrip("/")) or "~",
            "state": state,
            "detail": detail,
            "message": clean_text(raw_message),
            "time": d.get("statusUpdatedAt") or d.get("updatedAt") or d.get("startedAt"),
            "source": "desktop" if d.get("entrypoint") == "claude-desktop" else "cli",
            "url": claude_url(d),
            "pid": pid,
            "instance": claude_instance(pid)[0],
            "cost": claude_cost(sid, tpath),
        })
    return out


# ---------- Codex ----------

def codex_db():
    dbs = []
    for p in CODEX_HOME.glob("state_*.sqlite"):
        m = re.search(r"_(\d+)$", p.stem)
        if m:
            dbs.append((int(m.group(1)), p))
    return max(dbs)[1] if dbs else None


def parse_codex_rollout(path):
    state, at, message = None, None, None
    for raw in reversed(tail_lines(path)):
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        p = e.get("payload") or {}
        pt = p.get("type")
        if state is None and e.get("type") == "event_msg" and pt in ("task_started", "task_complete", "turn_aborted"):
            state = {"task_started": "working", "task_complete": "done", "turn_aborted": "aborted"}[pt]
            at = iso_to_ms(e.get("timestamp"))
            if pt == "task_complete" and p.get("last_agent_message"):
                message = p["last_agent_message"]
        if message is None and e.get("type") == "response_item" and pt == "message" and p.get("role") == "assistant":
            texts = [c.get("text", "") for c in p.get("content") or [] if c.get("type") == "output_text"]
            if any(t.strip() for t in texts):
                message = "\n".join(texts)
        if state and message:
            break
    return {"state": state, "at": at, "message": message}


def codex_connect(db):
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=2)
        conn.execute("select 1 from threads limit 1")
        return conn
    except sqlite3.OperationalError:
        # Po zamknięciu bazy przez Codex znikają pliki -wal/-shm, a połączenie „ro” nie umie ich
        # utworzyć. Bez -wal cała treść jest w głównym pliku, więc immutable czyta aktualny stan.
        return sqlite3.connect("file:%s?mode=ro&immutable=1" % db, uri=True, timeout=2)


def codex_sessions():
    db = codex_db()
    if not db:
        return []
    cutoff = now_ms() - CODEX_ACTIVE_HOURS * 3600 * 1000
    conn = codex_connect(db)
    try:
        rows = conn.execute(
            """
            select id, coalesce(nullif(name, ''), title), cwd, rollout_path, git_branch,
                   max(recency_at_ms, coalesce(updated_at_ms, updated_at * 1000)) as recent
            from threads
            where archived = 0 and source not like '{%' and recent > ?
            order by recent desc limit 60
            """,
            (cutoff,),
        ).fetchall()
    finally:
        conn.close()
    out = []
    for tid, title, cwd, rollout, branch, recent in rows:
        parsed = _parse_cache.get(rollout, parse_codex_rollout) or {}
        state = parsed.get("state") or "done"
        raw_message = parsed.get("message") or ""
        detail = None
        if state == "done" and asks_question(raw_message):
            state, detail = "waiting", "pytanie"
        out.append({
            "id": tid,
            "name": title or "wątek",
            "project": os.path.basename((cwd or "").rstrip("/")) or "~",
            "state": state,
            "detail": detail,
            "message": clean_text(raw_message),
            "time": parsed.get("at") or recent,
            "source": "codex",
            "url": "codex://threads/" + tid if UUID.match(tid or "") else None,
            "cost": cost_of([tally(rollout, consume_codex, (b'"token_usage_record"', b'"turn_context"'))]),
        })
    return out


# ---------- OpenUsage ----------

_usage_cache = {"at": 0, "data": None, "error": None}


def money(value):
    m = re.search(r"\$([\d,]+(?:\.\d+)?)", value or "")
    return float(m.group(1).replace(",", "")) if m else None


def tokens(value):
    m = re.search(r"([\d.,]+)\s*([KMB])?\s*tokens", value or "")
    if not m:
        return None
    return float(m.group(1).replace(",", "")) * {"K": 1e3, "M": 1e6, "B": 1e9}.get(m.group(2), 1)


def parse_provider(p, kind):
    lines = {l.get("label"): l for l in p.get("lines") or []}

    def bar(label):
        l = lines.get(label)
        if not l or l.get("type") != "progress":
            return None
        limit = l.get("limit") or 100
        return {"pct": round(100.0 * (l.get("used") or 0) / limit), "resetsAt": iso_to_ms(l.get("resetsAt"))}

    plan = p.get("plan") or ""
    price = PLAN_PRICES.get(kind, {}).get(plan.lower())
    month = money((lines.get("Last 30 Days") or {}).get("value"))
    trend = (lines.get("Usage Trend") or {}).get("points") or []
    return {
        "plan": plan,
        "session": bar("Session"),
        "weekly": bar("Weekly"),
        "trend": [{"label": t.get("label"), "value": t.get("value") or 0} for t in trend[-14:]],
        "todayTokens": tokens((lines.get("Today") or {}).get("value")),
        "today": money((lines.get("Today") or {}).get("value")),
        "month": month,
        "multiple": round(month / price, 1) if month is not None and price else None,
        "fetchedAt": iso_to_ms(p.get("fetchedAt")),
    }


def usage():
    if time.time() - _usage_cache["at"] < OPENUSAGE_TTL:
        return _usage_cache
    try:
        with urllib.request.urlopen(OPENUSAGE_URL, timeout=2) as r:
            providers = json.load(r)
        data = {}
        for p in providers:
            pid = p.get("providerId")
            if pid in ("claude", "codex"):
                data[pid] = parse_provider(p, pid)
                for kind in ("session", "weekly"):
                    bar = data[pid][kind]
                    if bar:
                        record_usage("%s:%s" % (pid, kind), bar)
                        bar["forecast"] = forecast("%s:%s" % (pid, kind), kind, bar)
        save_history()
        _usage_cache.update(at=time.time(), data=data, error=None)
    except Exception as exc:  # OpenUsage wyłączony / zmiana API
        _usage_cache.update(at=time.time(), error="OpenUsage niedostępny (%s)" % exc.__class__.__name__)
    return _usage_cache


# ---------- prognoza limitu ----------

# Z jakiego okna liczymy tempo i ile danych musi być, żeby prognoza miała sens.
FORECAST = {"session": (45 * 60e3, 10 * 60e3), "weekly": (24 * 3600e3, 3 * 3600e3)}

try:
    _history = json.loads(USAGE_HISTORY.read_text())
except (OSError, ValueError):
    _history = {}
_history_saved = time.time()


def record_usage(key, bar):
    if bar.get("resetsAt") is None:
        return
    t, reset_min = now_ms(), bar["resetsAt"] // 60000
    h = _history.setdefault(key, [])
    if h and abs(h[-1][2] - reset_min) > 1:
        h.clear()  # nowe okno limitu — stare tempo nie ma znaczenia
    h.append([t, bar["pct"], reset_min])
    keep = FORECAST[key.split(":")[1]][0]
    _history[key] = [x for x in h if x[0] >= t - keep]


def save_history():
    global _history_saved
    if time.time() - _history_saved < 300:
        return
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        USAGE_HISTORY.write_text(json.dumps(_history))
        _history_saved = time.time()
    except OSError:
        pass


def forecast(key, kind, bar):
    """Kiedy przy obecnym tempie skończy się limit. None = za mało danych."""
    if bar["pct"] >= 100:
        return {"exhausted": True}
    pts = _history.get(key) or []
    if len(pts) < 2 or pts[-1][0] - pts[0][0] < FORECAST[kind][1]:
        return None
    rate = (pts[-1][1] - pts[0][1]) / float(pts[-1][0] - pts[0][0])  # % na ms
    if rate <= 0:
        return {"eta": None, "beforeReset": False}
    eta = int(now_ms() + (100 - bar["pct"]) / rate)
    return {"eta": eta, "beforeReset": bool(bar.get("resetsAt")) and eta < bar["resetsAt"]}


# ---------- dane odświeżane w tle (GitHub, statusy) ----------

class Poller(threading.Thread):
    """Odpytuje wolne źródło co `interval` s; przy błędzie trzyma ostatni dobry wynik."""

    def __init__(self, fn, interval):
        super().__init__(daemon=True)
        self.fn, self.interval = fn, interval
        self.value, self.error, self.at = None, None, 0

    def run(self):
        while True:
            try:
                self.value, self.error, self.at = self.fn(), None, time.time()
            except Exception as exc:
                self.error = "%s: %s" % (exc.__class__.__name__, exc)
            time.sleep(self.interval)

    def snapshot(self):
        stale = time.time() - self.at > 3 * self.interval
        return {"data": self.value, "error": self.error if (self.value is None or stale) else None}


GH_QUERY = """
query {
  viewer { pullRequests(states: OPEN, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...pr } } }
  review: search(query: "is:open is:pr review-requested:@me archived:false", type: ISSUE, first: 10) {
    nodes { ... on PullRequest { ...pr } }
  }
}
fragment pr on PullRequest {
  number title url isDraft reviewDecision updatedAt
  repository { name }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
"""


def github_prs():
    if not GH:
        raise RuntimeError("brak gh")
    r = subprocess.run([GH, "api", "graphql", "-f", "query=" + GH_QUERY],
                       capture_output=True, text=True, timeout=30)
    if r.returncode:
        raise RuntimeError((r.stderr or "gh error").strip()[:200])
    d = json.loads(r.stdout)["data"]

    def pr(n, review):
        commits = (n.get("commits") or {}).get("nodes") or [{}]
        rollup = ((commits[-1].get("commit") or {}).get("statusCheckRollup") or {}).get("state")
        return {
            "url": n["url"], "number": n["number"], "title": n["title"], "repo": n["repository"]["name"],
            "draft": n.get("isDraft"), "review": review, "decision": n.get("reviewDecision"),
            "ci": rollup.lower() if rollup else None, "updated": iso_to_ms(n.get("updatedAt")),
        }

    out, seen = [], set()
    for n, review in [(n, True) for n in d["review"]["nodes"]] + [(n, False) for n in d["viewer"]["pullRequests"]["nodes"]]:
        if n and n.get("url") and n["url"] not in seen:
            seen.add(n["url"])
            out.append(pr(n, review))
    return out


def service_status():
    out = {}
    for tool, url in STATUS_PAGES.items():
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ai-panel"})
            with urllib.request.urlopen(req, timeout=8) as r:
                d = json.load(r)
            st = d.get("status") or {}
            open_incidents = [i.get("name") for i in d.get("incidents") or []
                              if i.get("status") not in ("resolved", "postmortem")]
            out[tool] = {"indicator": st.get("indicator") or "none", "description": st.get("description"),
                         "incident": open_incidents[0] if open_incidents else None}
        except Exception:
            out[tool] = {"indicator": "unknown", "description": "Brak danych o statusie"}
    return out


_github = Poller(github_prs, SLOW_POLL)
_status = Poller(service_status, SLOW_POLL)


# ---------- kalendarz ----------

def calendar():
    try:
        d = json.loads(CALENDAR_JSON.read_text())
    except (OSError, ValueError):
        return {"events": [], "error": "no_helper"}
    if d.get("updatedAt") and now_ms() - d["updatedAt"] > 10 * 60 * 1000:
        d["error"] = d.get("error") or "stale"
    return d


# ---------- HTTP ----------

_last_good = {}
GRACE = 120  # s — tyle pokazujemy ostatnie dobre dane, zanim zgłosimy błąd


def safe(fn, fallback):
    try:
        value = fn()
        _last_good[fn.__name__] = (time.time(), value)
        return value, None
    except Exception as exc:
        at, value = _last_good.get(fn.__name__, (0, fallback))
        if time.time() - at < GRACE:
            return value, None  # chwilowy błąd (np. baza w trakcie zapisu) — bez mrugania
        return fallback, "%s: %s" % (exc.__class__.__name__, exc)


def static_version():
    """Zmienia się przy każdej zmianie plików strony — kiosk wtedy sam się przeładowuje."""
    return max(int(f.stat().st_mtime) for f in STATIC.iterdir() if f.suffix in STATIC_TYPES)


def state():
    u = usage()
    claude, claude_err = safe(claude_sessions, [])
    codex, codex_err = safe(codex_sessions, [])
    cal, cal_err = safe(calendar, {"events": []})
    data = u.get("data") or {}
    return {
        "now": now_ms(),
        "claude": {"usage": data.get("claude"), "sessions": claude, "error": claude_err},
        "codex": {"usage": data.get("codex"), "sessions": codex, "error": codex_err},
        "usageError": u.get("error"),
        "version": static_version(),
        "calendar": dict(cal, error=cal_err or cal.get("error")),
        "github": _github.snapshot(),
        "status": _status.snapshot()["data"] or {},
    }


def open_session(tool, sid):
    """Otwiera sesję w aplikacji. URL bierzemy z naszych danych, nigdy od klienta."""
    sessions = {"claude": claude_sessions, "codex": codex_sessions}.get(tool)
    if not sessions:
        return False
    session = next((s for s in sessions() if s["id"] == sid and s.get("url")), None)
    if not session:
        return False
    cmd = ["/usr/bin/open"]
    if tool == "claude":
        # Obie instancje Claude rejestrują claude://, więc wskazujemy właściwą wprost.
        cmd += ["-b", claude_instance(session["pid"])[1]]
    subprocess.run(cmd + [session["url"]], check=False, timeout=5)
    return True


def open_target(body):
    """Klient podaje tylko, CO otworzyć; adres zawsze pochodzi z danych serwera."""
    kind = body.get("kind", "session")
    url = None
    if kind == "session":
        return open_session(str(body.get("tool")), str(body.get("id")))
    if kind == "pr":
        want = str(body.get("url"))
        if GH_PR.match(want) and any(p["url"] == want for p in _github.value or []):
            url = want
    elif kind == "event":
        ev = next((e for e in calendar().get("events", [])
                   if e.get("start") == body.get("start") and e.get("title") == body.get("title")), None)
        if ev and str(ev.get("link", "")).startswith("https://"):
            url = ev["link"]
    if not url:
        return False
    subprocess.run(["/usr/bin/open", url], check=False, timeout=5)
    return True


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def host_ok(self):
        # Ochrona przed DNS rebinding: obca strona nie może czytać API pod własną domeną.
        if self.headers.get("Host") in ALLOWED_HOSTS:
            return True
        self.send(421, b"misdirected request", "text/plain")
        return False

    def do_POST(self):
        if not self.host_ok():
            return
        # Tylko nasza własna strona (Origin) i tylko JSON — inna strona nie wywoła tego przez CSRF.
        origin = self.headers.get("Origin", "")
        if origin.split("://", 1)[-1] not in ALLOWED_HOSTS or self.headers.get("Content-Type") != "application/json":
            return self.send(403, b"forbidden", "text/plain")
        if self.path != "/api/open":
            return self.send(404, b"not found", "text/plain")
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 4096)))
            ok = open_target(body)
        except (ValueError, AttributeError):
            return self.send(400, b"bad request", "text/plain")
        self.send(200 if ok else 404, json.dumps({"ok": ok}).encode(), "application/json")

    def do_GET(self):
        if not self.host_ok():
            return
        path = self.path.split("?", 1)[0]
        if path == "/api/state":
            return self.send(200, json.dumps(state(), ensure_ascii=False).encode(), "application/json")
        name = "index.html" if path == "/" else path.lstrip("/")
        f = (STATIC / name).resolve()
        if STATIC in f.parents and f.is_file() and f.suffix in STATIC_TYPES:
            return self.send(200, f.read_bytes(), STATIC_TYPES[f.suffix])
        self.send(404, b"not found", "text/plain")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print("AI Panel: http://127.0.0.1:%d" % PORT, flush=True)
    _github.start()
    _status.start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
