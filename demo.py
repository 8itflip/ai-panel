"""Fikcyjne dane do zrzutów ekranu i testów wyglądu: AI_PANEL_DEMO=1 python3 server.py"""
import time

MIN = 60 * 1000
HOUR = 60 * MIN


def _session(i, tool, name, project, state, message, ago, cost, detail=None, instance=None):
    now = int(time.time() * 1000)
    return {
        "id": "%s-demo-%d" % (tool, i), "name": name, "project": project, "state": state, "detail": detail,
        "message": message, "time": now - ago, "source": tool, "url": None, "instance": instance,
        "cost": {"usd": cost, "partial": False}, "memory": 280e6 + i * 35e6, "stale": ago > 2 * 24 * HOUR,
    }


def _usage(plan, session_pct, weekly_pct, today, month, multiple, trend, reset_in, forecast=None):
    now = int(time.time() * 1000)
    return {
        "plan": plan,
        "session": {"pct": session_pct, "resetsAt": now + reset_in, "forecast": forecast},
        "weekly": {"pct": weekly_pct, "resetsAt": now + 4 * 24 * HOUR, "forecast": None},
        "trend": [{"label": "d%d" % i, "value": v * 1e6} for i, v in enumerate(trend)],
        "todayTokens": trend[-1] * 1e6, "today": today, "month": month, "multiple": multiple,
    }


def state():
    now = int(time.time() * 1000)
    claude = [
        _session(1, "claude", "Migrate auth to OAuth 2.1", "acme-api", "waiting",
                 "Both options work. Should I keep the legacy token endpoint for one more release?", 4 * MIN, 3.42, "question"),
        _session(2, "claude", "Fix flaky checkout tests", "web-shop", "working",
                 "Running the e2e suite again with the retry fix applied…", 1 * MIN, 1.87),
        _session(3, "claude", "Upgrade Postgres to 17", "infra", "working",
                 "Applying the migration on staging, 3 of 5 steps done.", 2 * MIN, 5.10, instance="Work"),
        _session(4, "claude", "Write release notes 2.4", "docs", "done",
                 "Release notes are ready in docs/releases/2.4.md and linked from the changelog.", 18 * MIN, 0.64),
        _session(5, "claude", "Add rate limiting", "acme-api", "done",
                 "Opened PR #212 with a token-bucket limiter and tests; CI is green.", 47 * MIN, 4.25),
        _session(6, "claude", "Dashboard dark mode", "web-shop", "done",
                 "Dark mode is done; colors pass contrast checks in both themes.", 2 * HOUR, 2.18),
        _session(7, "claude", "Investigate memory spike", "infra", "done",
                 "The spike comes from an unbounded cache in the image resizer; fix is in PR #88.", 3 * 24 * HOUR, 7.96,
                 instance="Work"),
        _session(8, "claude", "Refactor billing module", "acme-api", "done",
                 "Split billing into invoices and payments; behavior unchanged, 214 tests pass.", 4 * 24 * HOUR, 11.40),
    ]
    codex = [
        _session(1, "codex", "Review onboarding flow", "web-shop", "working",
                 "Checking each step of the signup wizard against the spec…", 1 * MIN, 0.42),
        _session(2, "codex", "Translate emails to German", "web-shop", "done",
                 "All 14 transactional emails are translated and previewed.", 25 * MIN, 0.31),
        _session(3, "codex", "Clean up feature flags", "acme-api", "done",
                 "Removed 9 stale flags and their dead code paths.", 1 * HOUR, 0.88),
        _session(4, "codex", "Benchmark JSON parsers", "infra", "done",
                 "simdjson is 3.1× faster on our payloads; results in bench/README.md.", 2 * HOUR, 1.12),
        _session(5, "codex", "Update dependencies", "docs", "aborted",
                 "", 4 * HOUR, 0.05),
    ]
    events = [
        ("Daily standup", 6 * MIN, 15, "#34C759", "https://meet.example.com/standup"),
        ("Architecture review", 2 * HOUR, 60, "#5856D6", "https://meet.example.com/arch"),
        ("1:1 with Alex", 4 * HOUR, 30, "#FF9500", None),
        ("Sprint planning", 20 * HOUR, 90, "#34C759", "https://meet.example.com/planning"),
    ]
    prs = [
        ("Add request tracing", "acme-api", 215, "pending", None, False, True),
        ("Rate limiting with token bucket", "acme-api", 212, "success", "APPROVED", False, False),
        ("Fix cache eviction in resizer", "infra", 88, "failure", None, False, False),
        ("Dark mode for dashboard", "web-shop", 341, "success", None, False, False),
        ("Release notes 2.4", "docs", 57, None, None, True, False),
    ]
    claude_usage = _usage("Max", 72, 41, 48.2, 912.0, 9.1,
                          [40, 55, 38, 70, 64, 20, 15, 80, 92, 61, 75, 88, 66, 58], 95 * MIN,
                          {"eta": now + 70 * MIN, "beforeReset": True})
    claude_usage["extra"] = {"used": 12.40, "limit": 50}
    codex_usage = _usage("Plus", 23, 12, 3.1, 64.0, 3.2, [5, 8, 3, 12, 9, 0, 0, 14, 11, 7, 10, 13, 6, 9], 3 * HOUR)
    codex_usage["credits"] = 18.50
    return {
        "now": now,
        "local": {"data": [
            {"repo": "web-shop", "branch": "feat/dark-mode", "files": 3, "ahead": 2, "noRemote": False},
            {"repo": "infra", "branch": "main", "files": 1, "ahead": 0, "noRemote": False},
        ], "error": None},
        "claude": {
            "usage": claude_usage,
            "sessions": claude, "error": None,
        },
        "codex": {
            "usage": codex_usage,
            "sessions": codex, "error": None,
        },
        "usageError": None,
        "version": 0,
        "calendar": {"events": [
            {"title": t, "start": now + s, "end": now + s + d * MIN, "allDay": False, "calendar": "Work",
             "color": c, "link": l} for t, s, d, c, l in events
        ]},
        "prs": [
            {"name": name, "error": None, "loading": False, "items": [
                {"url": "https://github.com/example/%s/pull/%d" % (repo, n), "ref": "#%d" % n, "title": title,
                 "repo": repo, "ci": ci, "decision": dec, "draft": draft, "review": review, "updated": now - i * HOUR}
                for i, (title, repo, n, ci, dec, draft, review) in enumerate(prs) if i in idx
            ]} for name, idx in (("Personal", (3,)), ("Work", (0, 1, 2)), ("Docs", (4,)))
        ],
        "status": {
            "claude": {"indicator": "none", "description": "All Systems Operational", "incident": None},
            "codex": {"indicator": "none", "description": "All Systems Operational", "incident": None},
        },
    }
