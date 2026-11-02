"""Renders the panel with demo data in headless Chrome and checks that every section filled in.

Catches front-end errors that blank part of the page. Skipped when Chrome is not installed.
"""
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHROME = next((p for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                           shutil.which("google-chrome"), shutil.which("chromium"))
               if p and os.path.exists(p)), None)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(CHROME, "Chrome not installed")
class UiSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        env = dict(os.environ, AI_PANEL_DEMO="1", AI_PANEL_PORT=str(cls.port))
        cls.proc = subprocess.Popen([sys.executable, str(ROOT / "server.py")], env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen("http://127.0.0.1:%d/api/state" % cls.port, timeout=1)
                break
            except OSError:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=5)

    def render(self, lang, size="1920,1080"):
        out = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--window-size=" + size, "--virtual-time-budget=5000",
             "--dump-dom", "http://127.0.0.1:%d/?lang=%s" % (self.port, lang)],
            capture_output=True, text=True, timeout=60)
        return out.stdout

    def test_every_section_renders(self):
        dom = self.render("en")
        count = lambda pattern: len(re.findall(pattern, dom))
        self.assertGreater(count(r'<li class="s '), 5, "session rows")
        self.assertGreater(count(r'<li class="ev '), 0, "calendar events")
        self.assertGreater(count(r'class="pr-group'), 2, "pull request groups")
        self.assertIn("Join", dom, "meeting bar")
        self.assertIn("runs out", dom, "limit forecast")
        self.assertIn("Local changes", dom, "local changes")
        self.assertNotIn("Your issues", dom)
        self.assertIn("Subscriptions", dom)
        self.assertIn("idle for 2+ days", dom, "idle sessions")
        self.assertIn("Migrate auth to OAuth 2.1", dom, "Claude chats")
        self.assertIn('<span class="inst">Codex</span>', dom, "Codex chats are tagged")
        self.assertIn('<span class="inst">Claude</span>', dom, "main Claude app chats are tagged")
        self.assertIn('<span class="inst">Work</span>', dom, "Parall instance chats keep their own tag")
        self.assertIn("Claude Team", dom)
        self.assertIn("Fable", dom, "model-specific weekly limit")
        self.assertIn("left at reset", dom, "window pace")
        self.assertIn('class="tick"', dom, "even-pace mark")
        self.assertEqual(count(r'class="cost-pair"'), 4, "one overall total and three account summaries")
        self.assertIn('id="subscription-total"', dom)
        self.assertNotIn("Jeff", dom)
        self.assertNotIn("× subscription", dom)
        self.assertNotIn("Loading…", dom)
        self.assertRegex(dom, r'id="time">\d{1,2}:\d{2}<', "clock")

    def test_polish_interface(self):
        dom = self.render("pl")
        self.assertIn("Kalendarz", dom)
        self.assertIn("wymaga Twojej uwagi", dom)

    def test_short_bar_display(self):
        dom = self.render("en", "1920,720")
        self.assertGreater(len(re.findall(r'<li class="s ', dom)), 3)


if __name__ == "__main__":
    unittest.main()
