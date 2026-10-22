# AI Panel

Dashboard na podłużny ekran 1920×720: sesje Claude Code i Codex, limity, koszty i najbliższe spotkania.
Działa w całości lokalnie, bez zależności (Python 3 ze standardową biblioteką + mały helper w Swift).

## Źródła danych

| Co | Skąd |
|---|---|
| Sesje Claude Code (desktop i CLI) | `~/.claude/sessions/<pid>.json` (status na żywo) + transkrypty w `~/.claude/projects/` |
| Wątki Codex (aplikacja i CLI) | `~/.codex/state_*.sqlite` (tabela `threads`) + pliki `rollout-*.jsonl` |
| Limity 5 h / tygodniowe, koszty | API OpenUsage: `http://127.0.0.1:6736/v1/usage` |
| Kalendarz | aplikacja Kalendarz (EventKit) → `bin/calendar-helper` → `~/Library/Caches/ai-panel/calendar.json` |

Statusy:
- **Czeka na Ciebie**: Claude zgłasza `waitingFor` (zgoda, pytanie), albo ostatnia odpowiedź agenta kończy się pytajnikiem („Pytanie do Ciebie”).
- **Pracuje**: Claude `status: busy`; Codex: ostatnie zdarzenie to `task_started`.
- **Gotowe** / **Przerwane**: tura zakończona / przerwana.

„Aktywne” sesje Claude to te z żywym procesem. Codex trzyma wszystkie wątki w jednym procesie,
więc dla niego aktywne = ruch w ciągu ostatnich 24 h (`CODEX_ACTIVE_HOURS` w `server.py`).

## Uruchomienie

```bash
./install.sh     # usługi launchd: serwer :7319, helper kalendarza i autostart kiosku
./kiosk.sh       # ręczne otwarcie panelu w Chrome (kiosk na podłużnym ekranie)
./uninstall.sh   # usuwa usługi
```

Kiosk startuje sam: usługa `local.ai-panel.kiosk` co 20 s sprawdza, czy podłączony jest ekran
o proporcjach > 2:1. Jeśli tak, otwiera na nim panel w osobnym profilu Chrome; po odłączeniu ekranu
zamyka to okno, żeby nie zostało na pełnym ekranie głównego monitora.

Do pracy nad wyglądem: `python3 server.py` i http://127.0.0.1:7319. Logi: `~/Library/Logs/ai-panel/`.
