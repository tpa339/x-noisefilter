# Noisefilter für X

Chrome-Extension (Manifest V3), die mit dem Decision-Modell **Jev** (`typesafe/jev-1.14`) über OpenRouter `POST /api/alpha/decisions` bewertet.

**Feed (Standard):** Jeder Post in Timeline, Suche, Listen und Profilen bekommt zwei `noul`-Fragen:
- `gehalt`: Bringt der Post etwas Konkretes (Information, Zahl, Quelle, Analyse, Erfahrung, begründeter Gedanke, Humor mit Pointe)? Im Zweifel ja.
- `koeder`: Ist er vor allem auf Reaktion angelegt (Rage-Bait, Engagement-Köder, Clickbait, alte Vorwürfe als Neuigkeit aufgewärmt)? Im Zweifel nein.

Eingeklappt wird bei Gehalt unter 40 % oder Köder ab 75 %, außer der Gehalt liegt bei 80 % oder mehr. Zitierte Posts gehen als Kontext mit.

**Antworten (optional, Schalter):** Unter einem geöffneten Post bewertet Jev jede Antwort mit dem Ausgangspost als Kontext: `bezug` (bezieht sich auf eine konkrete Aussage, statt generisch zu sein) und `gehalt`.

**Lokal, ohne API:** fast gleiche Texte verschiedener Konten (Duplikat) und, bei Antworten, reine Emoji-Antworten. Posts nur mit Bild oder Video werden nicht bewertet.

Bis zu 10 Posts pro Request. Deine letzten 8 Markierungen je Richtung gehen als `beispiele_leser` mit; markierte Posts bleiben nach Reload so, wie du sie entschieden hast.

## Installation

1. `chrome://extensions` öffnen, **Entwicklermodus** einschalten.
2. **Entpackte Erweiterung laden** → Ordner `extension/` wählen.
3. Extension-Symbol (Puzzle-Menü) → Einstellungsseite: OpenRouter-Key eintragen (mit Credit-Limit anlegen), **Key testen**.
4. Nach jeder Code-Änderung: auf `chrome://extensions` **↻** klicken **und** den X-Tab neu laden.

## Bedienung

- Statusanzeige unten links: wie viele Posts eingeklappt sind, oder der Fehlertext.
- Eingeklappter Post: **anzeigen** oder **falsch eingeklappt** (wird gespeichert und als Beispiel genutzt).
- „Wahrscheinlichkeiten zeigen“: kleine Zeile unter jedem Post mit den Werten und **ist Noise**.
- Schwellen auf der Einstellungsseite; Änderungen nutzen den Cache, kosten also nichts.
- Protokoll als JSON exportieren, um die Trefferquote auszuwerten.

## Datenfluss

Post-Texte und Handles gehen direkt an OpenRouter (und von dort an TypeSafe). Key, Cache und Protokoll liegen nur in `chrome.storage.local`. Keine weiteren Server.

## Robustheit gegen X

X (React) überschreibt Klassen und verwendet `<article>`-Elemente für andere Posts weiter. Daher: Zustand nur in `data-nf-*`-Attributen, jedes Banner trägt die ID seines Posts, jeder Scan gleicht alle Artikel neu ab. Fehlt das Banner, bleibt der Inhalt sichtbar (`:has()`), statt eine leere Fläche zu zeigen. Bei API-Fehlern bleibt alles sichtbar.

## Test

```sh
pip install playwright && playwright install chromium
python3 test/e2e.py
```

Lädt die Extension in Playwright-Chromium und bedient `x.com` mit Nachbauten (`test/feed.html`, `test/fixture.html`), die React-Eigenheiten simulieren (Klassen überschreiben, Kinder neu rendern, Artikel weiterverwenden). Jev ist simuliert, kein Netzwerk.

## Grenzen

- Der Decisions-Endpunkt ist **alpha**.
- Nur gegen Nachbauten getestet; das echte x.com blockiert automatisierte Browser. Offen: ob X nach dem Einklappen die Zellhöhen neu misst (sonst Lücken im Feed).
- Antworten auf Antworten werden gegen den Ausgangspost bewertet, nicht gegen den direkten Vorgänger.
- Trefferquote von Jev auf echten Posts noch nicht gemessen.

## Lizenz

MIT, siehe `LICENSE`.
