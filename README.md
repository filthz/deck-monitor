# Taskmonitor Deck

Stream-Deck-artige Live-Übersicht aller Claude Code und Qwen Code Sessions – für Browser und iPad im lokalen Netz.
Sessions in Orca lassen sich vom iPad aus fokussieren, mitlesen und beantworten.

```
./install-autostart.sh        # launchd-Agent: startet den Server beim Login, Neustart bei Absturz
./install-autostart.sh --uninstall
npm run install-hooks         # Hooks in ~/.claude/settings.json und ~/.qwen/settings.json eintragen
npm run uninstall-hooks       # wieder entfernen (Backups: settings.json.tm-backup-*)
npm start                     # Server manuell im Vordergrund (vorher Autostart entfernen)
```

Log: `~/Library/Logs/taskmonitor.log` – dort steht auch die iPad-URL mit Token.
Neustart nach Code-Änderungen: `launchctl kickstart -k gui/$(id -u)/com.taskmonitor.deck`

iPad: `http://<mac-ip>:7777/?token=…` in Safari öffnen → Teilen → „Zum Home-Bildschirm“.
Das Token wird danach als Cookie gemerkt.

## Zugriff

- Nur Clients aus `TASKMONITOR_ALLOW` (Standard `127.0.0.0/8,192.168.0.0/16`); alle anderen Verbindungen werden verworfen.
- UI und API brauchen das Token aus `.token` (localhost ausgenommen).
- `/event` (Hooks) nimmt nur Anfragen von localhost an.

## Status

| Status | Bedeutung |
|---|---|
| Wartet | Freigabe-Dialog, Rückfrage (AskUserQuestion) oder Plan-Freigabe |
| Fertig | Turn beendet – antippen und „Quittieren“ |
| Hintergrund | Turn beendet, aber Background-Task / Monitor läuft noch |
| Arbeitet | Prompt läuft, aktuelles Tool wird angezeigt |
| Bereit / Beendet | Session offen ohne Auftrag / Prozess weg (verschwindet nach 10 min) |

## Orca

Läuft Orca, liest der Server alle 2 s `orca worktree ps` und `orca terminal list` (CLI unter
`/Applications/Orca.app/Contents/Resources/bin/orca`, überschreibbar mit `ORCA_CLI`).
Orca-Sessions erscheinen damit auch ohne eigene Hooks – inklusive Tab-Titel, Branch und Monitor-Status.
Hook-Events aus Orca-Panes (`ORCA_PANE_KEY`) werden dann ignoriert, damit keine Kachel doppelt erscheint.

Im Detail-Sheet einer Orca-Session:
- **Bildschirm** – Live-Vorschau des Terminals (`orca terminal read --screen`), alle 2 s
- **Antworten** – Tasten `1` `2` `3` (Auswahl in Freigabe-/Frage-Dialogen), `⏎`, `Esc`, `Ctrl+C` (zweimal tippen)
  und freier Text, der mit Enter abgeschickt wird (`orca terminal send`)
- **In Orca öffnen** – `orca terminal switch` + Orca in den Vordergrund
- **Session schließen** (zweimal tippen) – schließt das Orca-Terminal und beendet damit den Agent;
  das Gespräch lässt sich mit `claude --resume` wieder aufnehmen

Sessions außerhalb von Orca (z. B. IntelliJ-Terminal) lassen sich nur **ausblenden**.

„Quittieren“ setzt eine fertige Session auf „Bereit“ (grau) – sie bleibt sichtbar, solange sie läuft.
Quittierungen werden in `acks.json` bzw. `state.json` gespeichert und überstehen Neustarts.
