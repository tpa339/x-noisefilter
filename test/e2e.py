"""End-to-End-Test der Extension mit nachgebautem X und simuliertem Jev.

Ausführen: python3 test/e2e.py (benötigt: pip install playwright && playwright install chromium)
Kein Netzwerk nötig: x.com und openrouter.ai werden per Playwright-Routing bedient.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
THREAD = (ROOT / "test" / "fixture.html").read_text(encoding="utf-8")
FEED = (ROOT / "test" / "feed.html").read_text(encoding="utf-8")
SHOTS = Path(os.environ.get("NF_SHOTS", tempfile.gettempdir()))

api_calls = []
failures = []


def check(cond, msg):
    print(("OK   " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


def post_probs(text):
    """(gehalt, koeder) für Feed-Posts."""
    if "S-1" in text or "Destatis" in text:
        return 0.9, 0.1
    if "böse" in text:
        return 0.2, 0.9
    if "Like wenn" in text:
        return 0.1, 0.95
    if "Analyse" in text:
        return 0.85, 0.9
    return 0.5, 0.5


def reply_probs(text):
    """(bezug, gehalt) für Antworten."""
    if any(k in text for k in ("S-1", "Prospekt")):
        return 0.92, 0.9
    if "böse" in text:
        return 0.6, 0.2
    return 0.08, 0.05


def fake_jev(route):
    body = json.loads(route.request.post_data or "{}")
    api_calls.append(body)
    st = body.get("state", {})
    answers = {}
    for a in st.get("posts", []):
        g, k = post_probs(a["text"])
        answers[f"p{a['nr']}_gehalt"] = {"type": "noul", "noul": g}
        answers[f"p{a['nr']}_koeder"] = {"type": "noul", "noul": k}
    for a in st.get("antworten", []):
        b, g = reply_probs(a["text"])
        answers[f"r{a['nr']}_bezug"] = {"type": "noul", "noul": b}
        answers[f"r{a['nr']}_gehalt"] = {"type": "noul", "noul": g}
    route.fulfill(
        status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"},
        body=json.dumps({"model": body.get("model"), "answers": answers,
                         "usage": {"input_tokens": 400, "output_tokens": 0, "cost": 0.00001}}),
    )


def fixture(route):
    body = THREAD if "/status/" in route.request.url else FEED
    route.fulfill(status=200, content_type="text/html", body=body)


STATE_JS = """() => [...document.querySelectorAll('article')].map(a => {
    const sib = a.nextElementSibling?.classList.contains('nf-tag') ? a.nextElementSibling : null;
    const own = a.querySelector(':scope > .nf-banner') || sib;
    const t = a.querySelector('[data-testid=tweetText], [data-testid=tweetPhoto]');
    return {
      id: a.dataset.nfId, role: a.dataset.nfRole, state: a.dataset.nfState || '',
      banner: a.querySelector(':scope > .nf-banner span')?.textContent || null,
      bannerFor: own?.dataset.for || null,
      nBanners: a.querySelectorAll('.nf-banner, .nf-tag').length + (sib ? 1 : 0) + (sib?.nextElementSibling?.classList.contains('nf-tag') ? 1 : 0),
      textVisible: !!t && t.offsetParent !== null,
    };
})"""


def by_id(page):
    return {s["id"]: s for s in page.evaluate(STATE_JS) if s["id"]}


def settled(page, n):
    page.wait_for_function(
        f"[...document.querySelectorAll('article[data-nf-role]')].filter(a => ['kept','collapsed','revealed'].includes(a.dataset.nfState) || (a.dataset.nfState === '' && a.dataset.nfStamp)).length >= {n}",
        timeout=15000)
    page.wait_for_timeout(400)


def no_stale(page):
    bad = [s for s in page.evaluate(STATE_JS) if s["bannerFor"] and s["bannerFor"] != s["id"] or s["nBanners"] > 1]
    bad += page.evaluate("""() => [...document.querySelectorAll('.nf-tag')]
        .filter(t => t.previousElementSibling?.dataset.nfId !== t.dataset.for).map(t => 'verwaist:' + t.dataset.for)""")
    return not bad, bad


with sync_playwright() as p, tempfile.TemporaryDirectory() as profile:
    ctx = p.chromium.launch_persistent_context(
        profile, channel="chromium", headless=True, viewport={"width": 1000, "height": 1400},
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
    )
    ctx.route("https://x.com/**", fixture)
    ctx.route("https://openrouter.ai/api/alpha/decisions", fake_jev)
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    sw.evaluate("chrome.storage.local.set({apiKey: 'sk-or-test'})")

    # ================= Feed =================
    print("--- Feed")
    page = ctx.new_page()
    page.goto("https://x.com/home")
    settled(page, 7)
    s = by_id(page)
    page.screenshot(path=str(SHOTS / "nf-feed.png"), full_page=True)

    check(s["301"]["state"] == "kept" and s["301"]["textVisible"], "Sachlicher Post bleibt sichtbar")
    check(s["302"]["banner"] == "Eingeklappt: Köder ohne Gehalt" and not s["302"]["textVisible"], f"Empörungs-Post eingeklappt: {s['302']['banner']}")
    check(s["303"]["state"] == "collapsed", "Engagement-Köder eingeklappt")
    check(s["304"]["banner"] == "Eingeklappt: Duplikat von @empoert1", f"Fast gleicher Post anderer Konten = Duplikat: {s['304']['banner']}")
    check(s["305"]["textVisible"] and s["305"]["state"] != "collapsed", "Reiner Bild-Post bleibt sichtbar, ohne Bewertung")
    check(s["306"]["state"] == "kept", "Viel Gehalt schützt vor Köder-Einklappen")
    check(s["307"]["state"] == "kept", "Meinung im Zweifel sichtbar")
    check(len([a for a in page.evaluate(STATE_JS) if not a["id"]]) == 1, "Werbung ohne Zeitstempel wird ignoriert")
    sent = [x for c in api_calls for x in c["state"].get("posts", [])]
    check(len(sent) == 5 and len(api_calls) == 1, f"5 Posts in 1 Request (Duplikat und Bild lokal): {len(sent)} in {len(api_calls)}")
    q = api_calls[0]["questions"]
    check(set(q) == {f"p{i}_{k}" for i in range(5) for k in ("gehalt", "koeder")}, "Feed-Fragen p{i}_gehalt / p{i}_koeder")
    check("Im Zweifel: false" in q["p0_koeder"]["instructions"] and "Im Zweifel: true" in q["p0_gehalt"]["instructions"], "Precision-first in beiden Fragen")
    pill = page.text_content("#nf-pill")
    check(pill == "Noisefilter: 3 von 7 Posts eingeklappt", f"Statusanzeige: {pill}")
    ok, bad = no_stale(page)
    check(ok, f"Kein Banner am falschen Post / keine Doppel-Banner: {bad}")

    # React überschreibt Klassen
    page.evaluate("clobberClasses()")
    page.wait_for_timeout(400)
    check(by_id(page)["302"]["state"] == "collapsed" and not by_id(page)["302"]["textVisible"], "Überschriebene Klassen ändern nichts")

    # React rendert Kinder neu: Banner weg -> Inhalt sofort sichtbar statt Leerfläche, danach Banner zurück
    page.evaluate("rerender('302')")
    immediate = by_id(page)["302"]
    check(immediate["textVisible"], "Nach Neu-Rendern sofort Inhalt statt leerer Fläche")
    page.wait_for_timeout(600)
    s = by_id(page)
    check(s["302"]["banner"] == "Eingeklappt: Köder ohne Gehalt" and not s["302"]["textVisible"], "Banner wird nach Neu-Rendern wiederhergestellt")

    # React verwendet eingeklappten Artikel für anderen Post weiter
    page.evaluate("reuse('303', {id: '308', user: 'statistik', text: 'Neue Zahlen: Inflation 2,1 % laut Destatis.'})")
    page.wait_for_function("document.querySelector('article[data-nf-id=\"308\"]')?.dataset.nfState === 'kept'", timeout=8000)
    s = by_id(page)
    check(s["308"]["textVisible"] and s["308"]["banner"] is None, "Weiterverwendeter Artikel: altes Banner weg, neuer Post sichtbar")
    ok, bad = no_stale(page)
    check(ok, f"Nach Weiterverwendung keine fremden Banner: {bad}")

    # Anzeigen + Feedback + Beispiele
    page.locator('article[data-nf-id="302"] .nf-banner button', has_text="anzeigen").click()
    page.wait_for_timeout(300)
    s = by_id(page)
    check(s["302"]["textVisible"] and s["302"]["state"] == "revealed", "„anzeigen“ blendet Post ein")
    check(s["302"]["bannerFor"] == "302" and s["302"]["nBanners"] == 1, "Eingeblendeter Post zeigt kleines Etikett mit Grund")
    page.locator('article[data-nf-id="303"], article[data-nf-id="308"]').first  # noqa
    # „ist Noise“ braucht das Etikett -> Debug an
    sw.evaluate("chrome.storage.local.set({debug: true})")
    page.wait_for_timeout(500)
    page.locator('article[data-nf-id="307"] + .nf-tag button', has_text="ist Noise").click()
    page.wait_for_timeout(500)
    log = sw.evaluate("chrome.storage.local.get('log').then(r => r.log)")
    check({e["id"]: e.get("feedback") for e in log}.get("307") == "noise", "„ist Noise“ im Protokoll")
    ok, bad = no_stale(page)
    check(ok, f"Debug-Etiketten ohne Doppel/Fremd-Banner: {bad}")
    page.screenshot(path=str(SHOTS / "nf-feed-debug.png"), full_page=True)

    n = len(api_calls)
    page.evaluate("""() => document.getElementById('col').insertAdjacentHTML('beforeend',
      `<div data-testid="cellInnerDiv"><article data-testid="tweet"><div class="body">
       <div data-testid="User-Name"><a href="/neu">neu</a></div>
       <a href="/neu/status/309"><time datetime="2026-11-18T10:00:00Z">1h</time></a>
       <div data-testid="tweetText">Ich halte das für überbewertet.</div></div></article></div>`)""")
    page.wait_for_function("document.querySelector('article[data-nf-id=\"309\"]')?.dataset.nfState === 'kept'", timeout=8000)
    ex = api_calls[-1]["state"].get("beispiele_leser")
    check(len(api_calls) == n + 1 and ex and any("zu früh" in e["text"] for e in ex["noise"]), "Markierung geht als Noise-Beispiel an Jev")

    # Schwelle ändern -> neu entscheiden ohne Aufruf
    n = len(api_calls)
    sw.evaluate("chrome.storage.local.set({gehaltThreshold: 0.6})")
    page.wait_for_function("document.querySelector('article[data-nf-id=\"309\"]')?.dataset.nfState === 'collapsed'", timeout=5000)
    check(len(api_calls) == n, "Schwellenänderung nutzt Cache")
    sw.evaluate("chrome.storage.local.set({gehaltThreshold: 0.4, debug: false})")

    page.reload()
    settled(page, 7)
    check(len(api_calls) == n, "Nach Reload alles aus dem Cache")
    check(by_id(page)["307"]["state"] == "collapsed", "Als Noise markierter Post bleibt nach Reload eingeklappt")

    # ================= Antworten =================
    print("--- Antworten")
    page.goto("https://x.com/autorin/status/100")
    page.wait_for_timeout(1500)
    check(not page.query_selector("article[data-nf-state='collapsed']") and not page.query_selector("#nf-pill"),
          "Antworten-Modus standardmäßig aus")
    sw.evaluate("chrome.storage.local.set({filterReplies: true})")
    settled(page, 7)
    s = by_id(page)
    check(s["100"]["role"] == "context" and s["100"]["state"] == "", "Ausgangspost unberührt")
    check(s["201"]["state"] == "kept", "Substanzielle Antwort sichtbar")
    check(s["202"]["banner"] == "Eingeklappt: ohne Bezug und Gehalt", f"Floskel eingeklappt: {s['202']['banner']}")
    check(s["203"]["banner"] == "Eingeklappt: nur Emoji/Erwähnung", "Emoji-only lokal")
    check(s["205"]["banner"] == "Eingeklappt: Duplikat von @copy1", "Duplikat lokal")
    rc = [c for c in api_calls if "antworten" in c["state"]]
    check(rc and rc[0]["state"]["post"].startswith("Anthropic geht morgen")
          and set(rc[0]["questions"]) == {f"r{i}_{k}" for i in range(len(rc[0]['state']['antworten'])) for k in ("bezug", "gehalt")},
          "Antwort-Requests mit Ausgangspost und r{i}_bezug/gehalt")
    page.wait_for_function("document.querySelector('article[data-nf-id=\"207\"]')?.dataset.nfState === 'kept'", timeout=8000)
    check(page.text_content("#nf-pill") == "Noisefilter: 5 von 7 Antworten eingeklappt", f"Statusanzeige: {page.text_content('#nf-pill')}")

    # ================= Fehler und Aus =================
    print("--- Fehler")
    sw.evaluate("chrome.storage.local.set({enabled: false})")
    page.wait_for_timeout(500)
    check(not page.query_selector("article[data-nf-state='collapsed']") and not page.query_selector(".nf-banner"), "Filter aus: alles sichtbar, keine Banner")
    sw.evaluate("chrome.storage.local.clear().then(() => chrome.storage.local.set({apiKey: 'bad'}))")
    ctx.unroute("https://openrouter.ai/api/alpha/decisions")
    ctx.route("https://openrouter.ai/api/alpha/decisions", lambda r: r.fulfill(
        status=401, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"},
        body=json.dumps({"error": {"code": 401, "message": "Missing Authentication header"}})))
    page.goto("https://x.com/home")
    page.wait_for_function("document.getElementById('nf-pill')?.textContent.includes('401')", timeout=10000)
    s = by_id(page)
    # 304 ist ein lokal erkanntes Duplikat und bleibt auch ohne API eingeklappt.
    check(all(x["textVisible"] for k, x in s.items() if x["role"] == "post" and k != "304")
          and s["304"]["state"] == "collapsed" and not page.query_selector("article[data-nf-state='pending']"),
          "API-Fehler: alles sichtbar (außer lokalem Duplikat), nichts dauerhaft abgedunkelt")
    check("Missing Authentication" in page.text_content("#nf-pill"), "Fehler steht in der Statusanzeige")
    ctx.close()

print(f"\n{len(failures)} Fehler")
sys.exit(1 if failures else 0)
