# Status · noisefilter
Zustand: aktiv
Aktualisiert: 2026-11-18

## Nächster Schritt
Auf echtem X prüfen (Tab des Nutzers): Lücken nach dem Einklappen (Zellhöhen), Selektoren, Layout des Etiketts. Danach Trefferquote über das exportierte Protokoll.

## Zuletzt
- 2026-11-18: v0.2: Feed-Posts als Standard (Fragen gehalt/koeder), Antworten optional; Darstellung robust gegen React (data-Attribute, Banner mit ID, Etikett als Geschwister); e2e 37/37 gegen Nachbau
- 2026-11-18: Nutzer-Test auf echtem X: Banner am falschen Post, Leerflächen, falsches Ziel (Threads statt Posts) → behoben bzw. offen (Lücken)
- 2026-11-18: Bündelung, „im Zweifel behalten“, Markierungen als Few-Shot
- 2026-11-18: Repo-Analyse (x-reply-filter, bluenoise, sharp, bouncer u. a.)
- 2026-11-18: Projekt angelegt, Recherche Decision Models

## To-dos
- [ ] Echtes X: Zellhöhen/Lücken nach Einklappen messen; ggf. Ansatz von control-panel-for-twitter ansehen
- [ ] Antworten-Modus: Antworten auf Antworten gegen direkten Vorgänger bewerten
- [ ] Trefferquote auswerten (Protokoll-Export)

## Entscheidungen
- [x] Ziel → Feed-Posts bewerten (Nutzer), Antworten nur optional
- [x] Fragen → Gehalt + Köder/Empörung statt Bot-/KI-Erkennung
- [x] Selbst bauen statt x-reply-filter (eigene Fragen, kein fremder Server)
