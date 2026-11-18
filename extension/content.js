// Noisefilter – Content Script für x.com
//
// Zwei Modi:
//  - Feed (Standard): jeder Post in Timeline, Suche, Listen, Profilen wird einzeln bewertet.
//  - Antworten (optional): auf Thread-Seiten (/status/<id>) werden die Antworten mit dem
//    Ausgangspost als Kontext bewertet.
//
// X (React) überschreibt Klassen und verwendet <article>-Elemente für andere Posts weiter.
// Deshalb: Zustand nur in data-Attributen, jedes Banner trägt die ID seines Posts, und jeder
// Scan gleicht alle sichtbaren Artikel neu ab (idempotent).

(() => {
  "use strict";

  const STATUS_RE = /\/status\/(\d+)/;
  const SCAN_DELAY_MS = 250;
  const DUP_JACCARD = 0.8;

  const settings = { enabled: true, debug: false, filterFeed: true, filterReplies: false };
  const results = new Map(); // id -> Ergebnis
  const inFlight = new Set();
  const threads = new Map(); // threadId -> { post, ancestors }
  const seen = new Map(); // Kontext ("feed" oder threadId) -> [{id, author, key, set}]
  let lastError = "";
  let scanTimer = null;

  // ---------- Einstellungen ----------

  async function loadSettings() {
    try {
      const s = await chrome.storage.local.get(Object.keys(settings));
      for (const k of Object.keys(settings)) if (typeof s[k] === "boolean") settings[k] = s[k];
    } catch (e) {
      console.warn("[noisefilter] Einstellungen nicht lesbar", e);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let rescan = false;
    for (const k of Object.keys(settings)) {
      if (k in changes) {
        settings[k] = changes[k].newValue !== undefined ? changes[k].newValue === true : k !== "debug" && k !== "filterReplies";
        rescan = true;
      }
    }
    if (["gehaltThreshold", "bezugThreshold", "baitThreshold"].some((k) => k in changes)) {
      // Neu entscheiden lassen; der Service Worker liefert die Wahrscheinlichkeiten aus dem Cache.
      for (const [id, r] of results) if (r.source === "jev" && !r.revealed) results.delete(id);
      rescan = true;
    }
    if (rescan) scheduleScan();
  });

  // ---------- DOM-Auslese ----------

  function threadIdFromUrl() {
    const m = location.pathname.match(STATUS_RE);
    return m ? m[1] : null;
  }

  function readArticle(article) {
    // Zitierte Posts liegen in div[role="link"]; deren Zeitstempel und Text getrennt lesen.
    const times = [...article.querySelectorAll('a[href*="/status/"] time')];
    const own = times.find((t) => !t.closest('div[role="link"]')) || times[0];
    const href = own?.closest("a")?.getAttribute("href") || "";
    const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null; // z. B. Werbung ohne Zeitstempel
    const texts = [...article.querySelectorAll('[data-testid="tweetText"]')];
    const ownText = texts.find((t) => !t.closest('div[role="link"]'));
    const quoted = texts.find((t) => t.closest('div[role="link"]'));
    return {
      id: m[2],
      author: m[1],
      text: (ownText?.innerText || "").trim(),
      quoted: (quoted?.innerText || "").trim(),
      hasMedia: !!article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"]'),
    };
  }

  // ---------- Lokale Regeln: Emoji-only und Duplikate ----------

  function tokens(text) {
    return text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/@\w+/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }

  function localVerdict(ctxKey, item, kind) {
    const toks = tokens(item.text);
    if (toks.length === 0) {
      if (item.hasMedia || item.quoted) return { collapse: false, reason: "nur Medien (nicht bewertet)", source: "lokal" };
      return kind === "reply" ? { collapse: true, reason: "nur Emoji/Erwähnung", source: "lokal" } : { collapse: false, reason: "kein Text", source: "lokal" };
    }
    const set = new Set(toks);
    const key = toks.join(" ");
    const list = seen.get(ctxKey) || [];
    seen.set(ctxKey, list);
    for (const prev of list) {
      if (prev.id === item.id || prev.author === item.author) continue;
      if (prev.key === key || (set.size >= 4 && jaccard(set, prev.set) >= DUP_JACCARD)) {
        return { collapse: true, reason: `Duplikat von @${prev.author}`, source: "lokal" };
      }
    }
    if (!list.some((p) => p.id === item.id)) list.push({ id: item.id, author: item.author, key, set });
    if (list.length > 500) list.splice(0, list.length - 500);
    return null;
  }

  // ---------- Darstellung ----------

  function pct(p) {
    return typeof p === "number" ? `${Math.round(p * 100)} %` : "–";
  }

  function scoreText(r) {
    if (r.source !== "jev") return r.reason || "";
    const parts = [];
    if (typeof r.pBezug === "number") parts.push(`Bezug ${pct(r.pBezug)}`);
    if (typeof r.pGehalt === "number") parts.push(`Gehalt ${pct(r.pGehalt)}`);
    if (typeof r.pBait === "number") parts.push(`Köder ${pct(r.pBait)}`);
    return parts.join(" · ");
  }

  function button(label, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
    });
    return b;
  }

  function sendFeedback(id, label) {
    chrome.runtime.sendMessage({ type: "feedback", id, label }).catch(() => {});
  }

  // Gewünschter Zustand eines Artikels als Schlüssel; nur bei Änderung wird neu gezeichnet.
  function desired(id) {
    if (!settings.enabled) return { state: "", key: "" };
    const r = results.get(id);
    if (!r) return inFlight.has(id) ? { state: "pending", key: "pending" } : { state: "", key: "" };
    if (r.error) return { state: "", key: settings.debug ? `err:${r.error}` : "", r };
    if (r.collapse && !r.revealed) return { state: "collapsed", key: `c:${r.reason}:${settings.debug}`, r };
    const showTag = settings.debug || r.collapse || r.feedback;
    return { state: r.collapse ? "revealed" : "kept", key: showTag ? `t:${r.collapse}:${r.feedback}:${settings.debug}` : "k", r };
  }

  // Banner (eingeklappt) liegt im Artikel, das kleine Etikett direkt danach als Geschwister,
  // damit es das Flex-Layout von X nicht berührt.
  function tagAfter(article) {
    const n = article.nextElementSibling;
    return n && n.classList.contains("nf-tag") ? n : null;
  }

  function removeOwn(article) {
    article.querySelectorAll(":scope > .nf-banner, :scope > .nf-tag").forEach((el) => el.remove());
    tagAfter(article)?.remove();
  }

  // Etiketten, deren Artikel weg ist oder inzwischen einen anderen Post zeigt.
  function removeOrphanTags() {
    document.querySelectorAll(".nf-tag").forEach((t) => {
      const a = t.previousElementSibling;
      if (!a || a.tagName !== "ARTICLE" || a.dataset.nfId !== t.dataset.for) t.remove();
    });
  }

  function decorate(article, id) {
    const want = desired(id);
    const stamp = `${id}|${want.key}`;
    const ownBanner = article.querySelector(":scope > .nf-banner") || tagAfter(article);
    const bannerOk = !ownBanner || ownBanner.dataset.for === id;
    const needsEl = want.state === "collapsed" || (want.key && want.key !== "k" && want.key !== "pending" && want.key !== "");
    if (article.dataset.nfStamp === stamp && bannerOk && (!needsEl || ownBanner)) {
      if (article.dataset.nfState !== want.state) article.dataset.nfState = want.state;
      return;
    }
    removeOwn(article);
    article.dataset.nfStamp = stamp;
    article.dataset.nfState = want.state;
    const r = want.r;
    if (!r) return;

    if (r.error) {
      if (settings.debug) article.after(tag(id, `Fehler: ${r.error}`));
      return;
    }

    if (want.state === "collapsed") {
      const banner = document.createElement("div");
      banner.className = "nf-banner";
      banner.dataset.for = id;
      const label = document.createElement("span");
      label.textContent = `Eingeklappt: ${r.reason}`;
      const who = document.createElement("span");
      who.className = "nf-dim";
      who.textContent = r.author ? `@${r.author}` : "";
      banner.append(
        label,
        who,
        button("anzeigen", "", () => {
          r.revealed = true;
          scheduleScan(0);
        }),
        button("falsch eingeklappt", "Als Fehlentscheidung speichern; ähnliche Posts werden künftig behalten", () => {
          r.revealed = true;
          r.feedback = "signal";
          sendFeedback(id, "signal");
          scheduleScan(0);
        }),
      );
      if (settings.debug && r.source === "jev") {
        const dbg = document.createElement("span");
        dbg.className = "nf-dim";
        dbg.textContent = scoreText(r);
        banner.append(dbg);
      }
      banner.addEventListener("click", (ev) => ev.stopPropagation());
      article.prepend(banner);
      return;
    }

    if (want.key === "k") return;
    let text = r.collapse ? `eingeklappt: ${r.reason}` : scoreText(r);
    if (r.feedback === "noise") text = "als Noise markiert";
    if (r.feedback === "signal") text = "von dir behalten";
    const canMark = !r.collapse && !r.feedback && r.source === "jev";
    article.after(
      tag(id, text, canMark ? () => {
        r.feedback = "noise";
        sendFeedback(id, "noise");
        scheduleScan(0);
      } : null),
    );
  }

  function tag(id, text, onNoise) {
    const el = document.createElement("div");
    el.className = "nf-tag";
    el.dataset.for = id;
    const span = document.createElement("span");
    span.textContent = text;
    el.append(span);
    if (onNoise) el.append(button("ist Noise", "Als übersehenes Noise speichern", onNoise));
    el.addEventListener("click", (ev) => ev.stopPropagation());
    return el;
  }

  function clearArticle(article) {
    removeOwn(article);
    delete article.dataset.nfState;
    delete article.dataset.nfStamp;
  }

  // ---------- Statusanzeige ----------

  function updatePill(mode, ids) {
    let pill = document.getElementById("nf-pill");
    if (!mode) {
      pill?.remove();
      return;
    }
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "nf-pill";
      pill.setAttribute("role", "status");
      document.body.append(pill);
    }
    let collapsed = 0;
    let pending = 0;
    for (const id of ids) {
      const r = results.get(id);
      if (!r) pending++;
      else if (r.collapse && !r.revealed) collapsed++;
    }
    const noun = mode === "reply" ? "Antworten" : "Posts";
    pill.classList.toggle("nf-pill-error", !!lastError);
    if (lastError) pill.textContent = `Noisefilter: ${lastError}`;
    else if (!ids.size) pill.textContent = `Noisefilter: warte auf ${noun} …`;
    else pill.textContent = `Noisefilter: ${collapsed} von ${ids.size} ${noun} eingeklappt${pending ? ` · prüfe ${pending} …` : ""}`;
  }

  // ---------- Scan ----------

  function scheduleScan(delay = SCAN_DELAY_MS) {
    if (scanTimer) {
      if (delay > 0) return;
      clearTimeout(scanTimer);
    }
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan().catch((e) => console.warn("[noisefilter] Scan fehlgeschlagen", e));
    }, delay);
  }

  async function scan() {
    // Foto-/Video-Overlay (/status/<id>/photo/1) liegt über dem Feed: nichts ändern.
    if (/\/status\/\d+\/(photo|video)\//.test(location.pathname)) return;
    const threadId = threadIdFromUrl();
    let mode = null;
    if (settings.enabled) mode = threadId ? (settings.filterReplies ? "reply" : null) : settings.filterFeed ? "post" : null;

    const articles = [...document.querySelectorAll('[data-testid="primaryColumn"] article[data-testid="tweet"]')];
    removeOrphanTags();
    if (!mode) {
      articles.forEach(clearArticle);
      updatePill(null);
      return;
    }

    const infos = articles.map((a) => ({ article: a, info: readArticle(a) }));
    let thread = null;
    if (mode === "reply") {
      thread = threads.get(threadId) || { post: null, ancestors: new Set() };
      threads.set(threadId, thread);
      const focalIdx = infos.findIndex((x) => x.info?.id === threadId);
      if (focalIdx >= 0) {
        const f = infos[focalIdx].info;
        thread.post = { id: f.id, author: f.author, text: f.text || f.quoted };
        infos.slice(0, focalIdx).forEach((x) => x.info && thread.ancestors.add(x.info.id));
      }
    }

    const ctxKey = mode === "reply" ? threadId : "feed";
    const ids = new Set();
    const toClassify = [];
    for (const { article, info } of infos) {
      if (!info) {
        clearArticle(article);
        continue;
      }
      if (article.dataset.nfId !== info.id) {
        clearArticle(article);
        article.dataset.nfId = info.id;
      }
      if (mode === "reply" && (info.id === threadId || thread.ancestors.has(info.id))) {
        article.dataset.nfRole = "context";
        clearArticle(article);
        continue;
      }
      article.dataset.nfRole = mode;
      ids.add(info.id);
      if (!results.has(info.id) && !inFlight.has(info.id)) {
        const local = localVerdict(ctxKey, info, mode);
        if (local) {
          results.set(info.id, { ...local, author: info.author });
        } else if (mode === "post" || thread.post) {
          inFlight.add(info.id);
          toClassify.push({ id: info.id, author: info.author, text: info.text, quoted: info.quoted });
        }
      }
      const r = results.get(info.id);
      if (r && !r.author) r.author = info.author;
      decorate(article, info.id);
    }
    updatePill(mode, ids);

    if (!toClassify.length) return;

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "classify",
        kind: mode,
        post: mode === "reply" ? thread.post : null,
        items: toClassify,
      });
    } catch (e) {
      resp = { error: String(e?.message || e) };
    }
    for (const it of toClassify) {
      inFlight.delete(it.id);
      const res = resp?.results?.[it.id];
      results.set(it.id, { ...(res || { error: resp?.error || "keine Antwort" }), author: it.author });
    }
    lastError = resp?.error || toClassify.map((it) => results.get(it.id)?.error).find(Boolean) || "";
    if (lastError) console.warn("[noisefilter]", lastError);
    scheduleScan(0);
  }

  // ---------- Start ----------

  (async () => {
    await loadSettings();
    const observer = new MutationObserver((records) => {
      // Eigene Änderungen (Banner, Status) nicht als Anlass für neue Scans werten.
      const foreign = records.some((rec) => {
        const t = rec.target;
        if (t.id === "nf-pill" || t.closest?.(".nf-banner, .nf-tag, #nf-pill")) return false;
        const nodes = [...rec.addedNodes, ...rec.removedNodes];
        return !nodes.length || nodes.some((n) => !(n.nodeType === 1 && (n.classList?.contains("nf-banner") || n.classList?.contains("nf-tag") || n.id === "nf-pill")));
      });
      if (foreign) scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleScan(0);
  })();
})();
