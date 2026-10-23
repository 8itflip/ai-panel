"""Server tests with made-up fixtures. Run with: python3 -m unittest discover -s tests"""
import http.client
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

PRICE = {"i": 3.0, "o": 15.0, "cr": 0.3, "cw": 3.75, "fast": 2}


def write_jsonl(path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(e) + "\n" for e in entries))


class Temp(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        server._health.clear()
        server._parse_cache.data.clear()
        server._transcript_paths.clear()
        server._tallies.clear()


class TextHelpers(unittest.TestCase):
    def test_clean_text_strips_markdown_and_directives(self):
        text = "**Done.** See `docs/a.md` and [the PR](https://x.y).\n\n:::writing{id=1} Body"
        self.assertEqual(server.clean_text(text), "Done. See docs/a.md and the PR. Body")

    def test_clean_text_truncates(self):
        self.assertEqual(len(server.clean_text("x" * 500, limit=50)), 50)

    def test_asks_question(self):
        self.assertTrue(server.asks_question("Should I keep the old endpoint?"))
        self.assertTrue(server.asks_question('Ship it now ("yes" or "no")?)'))
        self.assertFalse(server.asks_question("Done. Tests pass."))
        self.assertFalse(server.asks_question(""))

    def test_money_and_tokens(self):
        self.assertEqual(server.money("$1,044.78 · 2.8B tokens"), 1044.78)
        self.assertEqual(server.tokens("$1,044.78 · 2.8B tokens"), 2.8e9)
        self.assertEqual(server.tokens("$63.67 · 142.8M tokens"), 142.8e6)
        self.assertIsNone(server.money("no price"))


class Cost(Temp):
    def setUp(self):
        super().setUp()
        self.pricing = server._pricing.get
        server._pricing.get = lambda model: PRICE if model == "known-model" else None
        self.addCleanup(setattr, server._pricing, "get", self.pricing)

    def test_claude_cost_counts_each_response_once(self):
        usage = {"input_tokens": 1000, "output_tokens": 2000, "cache_read_input_tokens": 10000,
                 "cache_creation_input_tokens": 4000,
                 "cache_creation": {"ephemeral_1h_input_tokens": 1000, "ephemeral_5m_input_tokens": 3000}}
        line = {"type": "assistant", "message": {"id": "msg_1", "model": "known-model", "usage": usage}}
        path = self.dir / "t.jsonl"
        write_jsonl(path, [line, line, {"type": "user"}])  # the same response written twice
        t = server.tally(str(path), server.consume_claude, (b'"usage"',))
        expected = (1000 * 3 + 2000 * 15 + 10000 * 0.3 + 3000 * 3.75 + 1000 * 2 * 3) / 1e6
        self.assertAlmostEqual(t.cost, expected)
        self.assertEqual(t.unpriced, 0)

    def test_claude_fast_mode_and_unknown_model(self):
        fast = {"type": "assistant", "message": {"id": "a", "model": "known-model",
                                                 "usage": {"output_tokens": 1000, "speed": "fast"}}}
        unknown = {"type": "assistant", "message": {"id": "b", "model": "mystery", "usage": {"output_tokens": 1}}}
        path = self.dir / "t.jsonl"
        write_jsonl(path, [fast, unknown])
        t = server.tally(str(path), server.consume_claude, (b'"usage"',))
        self.assertAlmostEqual(t.cost, 1000 * 15 * 2 / 1e6)
        self.assertEqual(t.unpriced, 1)

    def test_tally_reads_only_appended_lines(self):
        path = self.dir / "t.jsonl"
        line = lambda i: {"type": "assistant", "message": {"id": str(i), "model": "known-model",
                                                           "usage": {"output_tokens": 1000}}}
        write_jsonl(path, [line(1)])
        server.tally(str(path), server.consume_claude, (b'"usage"',))
        with open(path, "a") as f:
            f.write(json.dumps(line(2)) + "\n")
        t = server.tally(str(path), server.consume_claude, (b'"usage"',))
        self.assertAlmostEqual(t.cost, 2 * 1000 * 15 / 1e6)

    def test_codex_cost_uses_model_from_turn_context(self):
        path = self.dir / "rollout.jsonl"
        write_jsonl(path, [
            {"type": "turn_context", "payload": {"model": "known-model"}},
            {"type": "token_usage_record", "payload": {"response_id": "r1", "usage": {
                "input_tokens": 10000, "cached_input_tokens": 8000, "output_tokens": 500}}},
            {"type": "token_usage_record", "payload": {"response_id": "r1", "usage": {"input_tokens": 99}}},
        ])
        t = server.tally(str(path), server.consume_codex, (b'"token_usage_record"', b'"turn_context"'))
        self.assertAlmostEqual(t.cost, (2000 * 3 + 8000 * 0.3 + 500 * 15) / 1e6)


class Forecast(unittest.TestCase):
    def setUp(self):
        self.now = server.now_ms
        self.addCleanup(setattr, server, "now_ms", self.now)
        server._history.clear()

    def at(self, ms):
        server.now_ms = lambda: ms

    def test_exhausted(self):
        self.assertEqual(server.forecast("x:session", "session", {"pct": 100}), {"exhausted": True})

    def test_needs_ten_minutes_of_data(self):
        bar = {"pct": 10, "resetsAt": 10 * 3600_000}
        self.at(0)
        server.record_usage("x:session", bar)
        self.at(5 * 60_000)
        server.record_usage("x:session", dict(bar, pct=12))
        self.assertIsNone(server.forecast("x:session", "session", dict(bar, pct=12)))

    def test_runs_out_before_reset(self):
        reset = 5 * 3600_000
        for minute, pct in ((0, 10), (20, 30)):  # 1% per minute
            self.at(minute * 60_000)
            server.record_usage("x:session", {"pct": pct, "resetsAt": reset})
        f = server.forecast("x:session", "session", {"pct": 30, "resetsAt": reset})
        self.assertTrue(f["beforeReset"])
        self.assertEqual(f["eta"], (20 + 70) * 60_000)

    def test_new_window_resets_history(self):
        self.at(0)
        server.record_usage("x:session", {"pct": 90, "resetsAt": 3600_000})
        self.at(60_000)
        server.record_usage("x:session", {"pct": 1, "resetsAt": 6 * 3600_000})
        self.assertEqual(len(server._history["x:session"]), 1)


class ClaudeSessions(Temp):
    def setUp(self):
        super().setUp()
        for name in ("CLAUDE_SESSIONS", "CLAUDE_PROJECTS", "CLAUDE_APP_SESSIONS", "PARALL_DIR"):
            self.addCleanup(setattr, server, name, getattr(server, name))
        server.CLAUDE_SESSIONS = self.dir / "sessions"
        server.CLAUDE_PROJECTS = self.dir / "projects"
        server.CLAUDE_APP_SESSIONS = [self.dir / "app"]
        server.PARALL_DIR = self.dir / "parall"
        server.CLAUDE_SESSIONS.mkdir()

    def app_session(self, sid, root=None, **fields):
        """A session the Claude app lists but has put to sleep (no live process)."""
        meta = dict({"sessionId": "local_" + sid, "cliSessionId": sid, "cwd": "/tmp/web-shop", "title": "Sleeping " + sid,
                     "isArchived": False, "lastActivityAt": server.now_ms() - 3600_000}, **fields)
        path = (root or self.dir / "app") / "account" / "org" / ("local_%s.json" % sid)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(meta))
        write_jsonl(server.CLAUDE_PROJECTS / "-tmp-web-shop" / ("%s.jsonl" % sid), [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "Merged."}]}}])

    def test_sleeping_app_sessions_are_listed(self):
        self.session("live", status="busy")
        self.app_session("s1")
        self.app_session("s2", root=self.dir / "parall" / "Claude (Work)" / "claude-code-sessions")
        self.app_session("old", lastActivityAt=server.now_ms() - 3 * 24 * 3600_000)
        self.app_session("archived", isArchived=True)
        sessions = {s["id"]: s for s in server.claude_sessions()}
        self.assertEqual(set(sessions), {"live", "s1", "s2"})
        self.assertEqual((sessions["s1"]["state"], sessions["s1"]["url"]), ("done", "claude://code/continue?session=local_s1"))
        self.assertEqual(sessions["s2"]["instance"], "Work")

    def test_live_session_is_not_listed_twice(self):
        self.session("both")
        self.app_session("both")
        self.assertEqual([s["id"] for s in server.claude_sessions()], ["both"])

    def session(self, sid, **fields):
        data = dict({"pid": os.getpid(), "sessionId": sid, "cwd": "/tmp/acme-api", "status": "idle",
                     "updatedAt": server.now_ms()}, **fields)
        (server.CLAUDE_SESSIONS / ("%s.json" % sid)).write_text(json.dumps(data))
        write_jsonl(server.CLAUDE_PROJECTS / "-tmp-acme-api" / ("%s.jsonl" % sid), [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "All tests pass."}]}},
        ])

    def test_states(self):
        self.session("a", status="busy", name="Working one")
        self.session("b", status="idle", waitingFor="permission")
        self.session("c", status="idle")
        states = {s["id"]: s["state"] for s in server.claude_sessions()}
        self.assertEqual(states, {"a": "working", "b": "waiting", "c": "done"})
        self.assertNotIn("claude", server._health)

    def test_question_counts_as_waiting(self):
        self.session("q")
        write_jsonl(server.CLAUDE_PROJECTS / "-tmp-acme-api" / "q.jsonl", [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "Keep the old API?"}]}}])
        s = server.claude_sessions()[0]
        self.assertEqual((s["state"], s["detail"]), ("waiting", "question"))

    def test_idle_for_days_is_stale(self):
        self.session("old", updatedAt=server.now_ms() - 3 * 24 * 3600_000)
        self.assertTrue(server.claude_sessions()[0]["stale"])

    def test_format_change_without_status_field(self):
        self.session("x")
        data = json.loads((server.CLAUDE_SESSIONS / "x.json").read_text())
        del data["status"]
        (server.CLAUDE_SESSIONS / "x.json").write_text(json.dumps(data))
        server.claude_sessions()
        self.assertIn("status field", server._health.get("claude", ""))


class CodexSessions(Temp):
    COLUMNS = ("id text, title text, name text, cwd text, rollout_path text, archived int, source text, "
               "updated_at int, updated_at_ms int, recency_at_ms int, git_branch text")

    def setUp(self):
        super().setUp()
        self.addCleanup(setattr, server, "CODEX_HOME", server.CODEX_HOME)
        server.CODEX_HOME = self.dir

    def database(self, columns=COLUMNS, threads=()):
        conn = sqlite3.connect(str(self.dir / "state_5.sqlite"))
        conn.execute("create table threads (%s)" % columns)
        for t in threads:
            conn.execute("insert into threads (id, title, name, cwd, rollout_path, archived, source, updated_at, "
                         "updated_at_ms, recency_at_ms, git_branch) values (?,?,?,?,?,0,?,?,?,?,'main')", t)
        conn.commit()
        conn.close()

    def thread(self, tid, events, source="vscode"):
        rollout = self.dir / ("rollout-%s.jsonl" % tid)
        write_jsonl(rollout, events)
        now = server.now_ms()
        return (tid, "Thread " + tid, None, "/tmp/web-shop", str(rollout), source, now // 1000, now, now)

    def test_states_and_subagents_hidden(self):
        done = [{"type": "event_msg", "timestamp": "2026-01-01T10:00:00Z", "payload": {
            "type": "task_complete", "last_agent_message": "Translated all emails."}}]
        working = [{"type": "event_msg", "timestamp": "2026-01-01T10:00:00Z", "payload": {"type": "task_started"}}]
        self.database(threads=[self.thread("t1", done), self.thread("t2", working),
                               self.thread("t3", done, source='{"subagent":{}}')])
        states = {s["id"]: s["state"] for s in server.codex_sessions()}
        self.assertEqual(states, {"t1": "done", "t2": "working"})
        self.assertNotIn("codex", server._health)

    def test_format_change_missing_column(self):
        self.database(columns=self.COLUMNS.replace("rollout_path text, ", ""))
        self.assertEqual(server.codex_sessions(), [])
        self.assertIn("rollout_path", server._health["codex"])

    def test_format_change_unknown_events(self):
        events = [{"type": "renamed_event", "payload": {"type": "something_new"}}]
        self.database(threads=[self.thread("t%d" % i, events) for i in range(3)])
        server.codex_sessions()
        self.assertIn("no task_started", server._health["codex"])

    def test_reads_database_without_wal_files(self):
        self.database(threads=[self.thread("t1", [])])
        for suffix in ("-wal", "-shm"):
            (self.dir / ("state_5.sqlite" + suffix)).unlink(missing_ok=True)
        self.assertEqual(len(server.codex_sessions()), 1)


class OpenUsageAccounts(Temp):
    def setUp(self):
        super().setUp()
        providers = [
            {"providerId": "claude", "plan": "Pro", "displayName": "Claude: me@example.com's Organization (me@example.com)",
             "lines": [{"label": "Session", "type": "progress", "used": 40, "limit": 100}]},
            {"providerId": "claude@1a2b", "plan": "Team", "displayName": "Claude: Zeta Corp (me@zeta.example)",
             "lines": [{"label": "Weekly", "type": "progress", "used": 25, "limit": 100}]},
            {"providerId": "claude@3c4d", "plan": "Max", "displayName": "Claude: Acme (Labs) (me@acme.example)",
             "lines": [{"label": "Session", "type": "progress", "used": 5, "limit": 100}]},
        ]
        body = json.dumps(providers).encode()

        class Response:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, *a): return body

        urlopen = server.urllib.request.urlopen
        server.urllib.request.urlopen = lambda *a, **k: Response()
        self.addCleanup(setattr, server.urllib.request, "urlopen", urlopen)
        self.addCleanup(setattr, server, "save_history", server.save_history)
        server.save_history = lambda: None
        server._usage_cache.update(at=0)

    def test_extra_claude_logins_are_listed_by_organization(self):
        data = server.usage()["data"]
        self.assertEqual(data["claude"]["session"]["pct"], 40)
        self.assertIsNone(data["claude"]["label"])  # a personal plan: the page names it itself
        accounts = data["claudeAccounts"]
        self.assertEqual([(a["label"], a["plan"]) for a in accounts], [("Acme (Labs)", "Max"), ("Zeta Corp", "Team")])
        self.assertEqual(accounts[1]["weekly"]["pct"], 25)
        self.assertIsNone(accounts[1]["session"])


class PullRequestGroups(unittest.TestCase):
    def setUp(self):
        for name in ("PR_GROUPS", "_gitlab"):
            self.addCleanup(setattr, server, name, getattr(server, name))
        self.addCleanup(setattr, server._github, "value", server._github.value)
        server._github.value = [
            {"url": "https://github.com/me/a/pull/1", "owner": "me"},
            {"url": "https://github.com/work-org/b/pull/2", "owner": "Work-Org"},
            {"url": "https://github.com/someone/c/pull/3", "owner": "someone"},
        ]
        server._github.at = time.time()
        gitlab = server.Poller(lambda: [], 60)
        gitlab.value, gitlab.at = [{"url": "https://gitlab.example.com/x/-/merge_requests/4"}], time.time()
        server._gitlab = {"gitlab.example.com": gitlab}

    def test_groups_by_owner_and_host(self):
        server.PR_GROUPS = [{"name": "Personal", "github": ["me"]},
                            {"name": "Client", "gitlab": "gitlab.example.com"},
                            {"name": "Work", "github": ["work-org"]}]
        groups = {g["name"] or "other": len(g["items"]) for g in server.pr_groups()}
        self.assertEqual(groups, {"Personal": 1, "Client": 1, "Work": 1, "other": 1})

    def test_without_config_everything_is_one_group(self):
        server.PR_GROUPS = [{"name": None, "github": ["*"]}]
        groups = server.pr_groups()
        self.assertEqual([len(g["items"]) for g in groups], [3])


class CheckerStart(unittest.TestCase):
    def test_parallel_requests_start_the_git_checker_once(self):
        errors = []

        def start():
            try:
                server.start_local_checker()
            except Exception as exc:  # the bug: "threads can only be started once"
                errors.append(exc)

        threads = [threading.Thread(target=start) for _ in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertTrue(server._local.is_alive())


@unittest.skipUnless(shutil.which("git"), "git not installed")
class LocalChanges(Temp):
    def setUp(self):
        super().setUp()
        self.addCleanup(server._session_dirs.clear)
        server._toplevels.clear()

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.dir)] + list(args), check=True, capture_output=True,
                       env=dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
                                GIT_COMMITTER_EMAIL="t@t"))

    def test_uncommitted_files_are_listed(self):
        self.git("init", "-q", "-b", "main")
        (self.dir / "a.txt").write_text("a")
        self.git("add", "a.txt")
        self.git("commit", "-q", "-m", "init")
        (self.dir / "b.txt").write_text("b")
        server._session_dirs.add(str(self.dir))
        repos = server.local_changes()
        self.assertEqual(len(repos), 1)
        self.assertEqual((repos[0]["branch"], repos[0]["files"], repos[0]["noRemote"]), ("main", 1, True))

    def test_clean_repository_is_not_listed(self):
        self.git("init", "-q", "-b", "main")
        (self.dir / "a.txt").write_text("a")
        self.git("add", "a.txt")
        self.git("commit", "-q", "-m", "init")
        server._session_dirs.add(str(self.dir))
        self.assertEqual(server.local_changes(), [])


class HttpSecurity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.allowed = server.ALLOWED_HOSTS
        server.ALLOWED_HOSTS = {"127.0.0.1:%d" % cls.port}
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        server.ALLOWED_HOSTS = cls.allowed

    def request(self, method, path, headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request(method, path, body=body, headers=headers or {})
        return conn.getresponse().status

    def test_foreign_host_is_rejected(self):
        self.assertEqual(self.request("GET", "/", {"Host": "evil.example:%d" % self.port}), 421)

    def test_page_is_served(self):
        self.assertEqual(self.request("GET", "/"), 200)

    def test_path_traversal_is_blocked(self):
        self.assertEqual(self.request("GET", "/../server.py"), 404)

    def test_open_requires_our_origin_and_json(self):
        origin = "http://127.0.0.1:%d" % self.port
        body = json.dumps({"kind": "pr", "url": "https://github.com/x/y/pull/1"})
        self.assertEqual(self.request("POST", "/api/open", {"Origin": "https://evil.example",
                                                            "Content-Type": "application/json"}, body), 403)
        self.assertEqual(self.request("POST", "/api/open", {"Origin": origin, "Content-Type": "text/plain"}, body), 403)

    def test_open_ignores_unknown_urls(self):
        origin = "http://127.0.0.1:%d" % self.port
        body = json.dumps({"kind": "pr", "url": "https://evil.example/pull/1"})
        self.assertEqual(self.request("POST", "/api/open", {"Origin": origin,
                                                            "Content-Type": "application/json"}, body), 404)


if __name__ == "__main__":
    unittest.main()
