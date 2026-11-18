// Noisefilter – Service Worker
// Bewertet Posts (Feed) oder Antworten (Thread) gebündelt über OpenRouters
// Decisions-Endpunkt (Jev). Deine Markierungen gehen als Beispiele mit.
// Kein Zustand in Variablen: alles liegt in chrome.storage.local.

const DEFAULTS = {
  apiBase: "https://openrouter.ai",
  model: "typesafe/jev-1.14",
  gehaltThreshold: 0.4,
  baitThreshold: 0.75,
  bezugThreshold: 0.35,
  concurrency: 3,
  batchSize: 10,
};
const CACHE_MAX = 5000;
const LOG_MAX = 2000;
const EXAMPLES_PER_SIDE = 8;
const EXAMPLE_CHARS = 200;
// Ein Post mit viel Gehalt wird auch bei Köder-Verdacht nicht eingeklappt.
const BAIT_GEHALT_OVERRIDE = 0.8;

const FAIRNESS =
  "Kurze, zugespitzte, umgangssprachliche, sarkastische oder fremdsprachige Texte und Tippfehler sind für sich kein Beleg. Bewerte die Bedeutung, nicht den Stil.";

// ---------- Fragen ----------

const Q = {
  post: {
    gehalt: {
      instructions: `Bringt dieser Post einem interessierten Leser etwas Konkretes? ${FAIRNESS} Im Zweifel: true.`,
      criteria: {
        true: "Mindestens eines: neue oder überprüfbare Information, Zahl oder Quelle; Analyse oder Erklärung; eigene Fach- oder Praxiserfahrung; ein eigener Gedanke mit Begründung; Humor mit echter Pointe. Oder die Lage ist unklar.",
        false: "Eindeutig leer: Floskel, Stimmungsmache ohne Inhalt, Engagement-Köder, Eigenwerbung ohne Substanz, bloßes Wiederholen einer Schlagzeile ohne jeden Zusatz.",
      },
    },
    koeder: {
      instructions: `Ist dieser Post vor allem auf Reaktion statt auf Information angelegt? ${FAIRNESS} Kritik oder eine klare Meinung allein ist kein Köder. Im Zweifel: false.`,
      criteria: {
        true: "Hauptzweck ist Empörung oder Rage-Bait, Engagement-Köder ('Like wenn …', 'Wer stimmt zu?'), Clickbait ohne Auflösung, oder alte Vorwürfe, Papers oder Zitate werden ohne neuen Anlass als Neuigkeit aufgewärmt, um Stimmung zu machen.",
        false: "Teilt Information, Analyse, Erfahrung, Humor oder eine begründete Meinung, auch wenn sie zugespitzt oder kritisch ist. Oder die Lage ist unklar.",
      },
    },
  },
  reply: {
    bezug: {
      instructions: `Bezieht sich diese Antwort auf eine konkrete Aussage, ein Detail oder eine Behauptung des Ausgangsposts (post)? ${FAIRNESS} Im Zweifel: true.`,
      criteria: {
        true: "Greift erkennbar etwas Konkretes aus dem Post auf: widerspricht, ergänzt, fragt gezielt nach, korrigiert, scherzt über etwas Bestimmtes. Oder die Lage ist unklar.",
        false: "Eindeutig generisch: könnte unverändert unter fast jedem anderen Post stehen, z. B. Floskel, Lob, Werbung, Eigenwerbung, Themenwechsel.",
      },
    },
    gehalt: {
      instructions: `Bringt diese Antwort einem Leser des Posts etwas Konkretes? ${FAIRNESS} Im Zweifel: true.`,
      criteria: {
        true: "Mindestens eines: überprüfbare Tatsache, Zahl oder Quelle; begründetes Gegenargument; sachliche Korrektur; eigene Fach- oder Praxiserfahrung; echte, präzise Rückfrage; ein pointierter Gedanke zum Thema. Oder die Lage ist unklar.",
        false: "Eindeutig leer: nur Zustimmung, Ablehnung, Empörung, Spott, Emoji, Schlagworte, Engagement-Köder oder Meinung ohne jeden Grund.",
      },
    },
  },
};

const EXAMPLE_HINT =
  " Falls vorhanden: beispiele_leser zeigt Texte, die der Leser selbst als 'behalten' oder 'noise' markiert hat. Urteile bei ähnlichen Texten genauso.";

// ---------- Speicher ----------

async function getSettings() {
  const s = await chrome.storage.local.get(["apiKey", ...Object.keys(DEFAULTS)]);
  const out = { ...DEFAULTS, apiKey: s.apiKey || "" };
  for (const k of Object.keys(DEFAULTS)) if (s[k] !== undefined && s[k] !== "") out[k] = s[k];
  for (const k of ["gehaltThreshold", "baitThreshold", "bezugThreshold"]) out[k] = Number(out[k]);
  out.concurrency = Math.max(1, Math.min(6, Number(out.concurrency) || DEFAULTS.concurrency));
  out.batchSize = Math.max(1, Math.min(25, Number(out.batchSize) || DEFAULTS.batchSize));
  return out;
}

// Schreibzugriffe nacheinander ausführen, damit parallele Aufrufe sich nicht überschreiben.
let writeChain = Promise.resolve();
function serialized(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

function trimObject(obj, max) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return obj;
  keys.sort((a, b) => (obj[a].ts || 0) - (obj[b].ts || 0));
  for (const k of keys.slice(0, keys.length - max)) delete obj[k];
  return obj;
}

function saveBatch(entries, usage, error) {
  return serialized(async () => {
    const { cache = {}, log = [], stats = {} } = await chrome.storage.local.get(["cache", "log", "stats"]);
    for (const k of ["calls", "requests", "cost", "errors"]) stats[k] = stats[k] || 0;
    if (error) {
      stats.errors++;
    } else {
      stats.requests++;
      stats.cost += Number(usage?.cost) || 0;
      for (const e of entries) {
        cache[`${e.kind}:${e.id}`] = { ts: e.ts, p: e.p, model: e.model };
        stats.calls++;
        log.unshift(e);
      }
      if (log.length > LOG_MAX) log.length = LOG_MAX;
    }
    await chrome.storage.local.set({ cache: trimObject(cache, CACHE_MAX), log, stats });
  });
}

// Markierung: im Protokoll (Auswertung, Beispiele) und im Cache (bleibt nach Reload).
function saveFeedback(id, label) {
  return serialized(async () => {
    const { log = [], cache = {} } = await chrome.storage.local.get(["log", "cache"]);
    for (const e of log) {
      if (e.id === id) {
        e.feedback = label;
        e.feedbackTs = Date.now();
      }
    }
    for (const kind of ["post", "reply"]) if (cache[`${kind}:${id}`]) cache[`${kind}:${id}`].override = label;
    await chrome.storage.local.set({ log, cache });
  });
}

async function getExamples(kind) {
  const { log = [] } = await chrome.storage.local.get("log");
  const pick = (label) =>
    log
      .filter((e) => e.kind === kind && e.feedback === label && e.text)
      .sort((a, b) => (b.feedbackTs || 0) - (a.feedbackTs || 0))
      .slice(0, EXAMPLES_PER_SIDE)
      .map((e) =>
        kind === "reply"
          ? { post: (e.postText || "").slice(0, EXAMPLE_CHARS), antwort: e.text.slice(0, EXAMPLE_CHARS) }
          : { text: e.text.slice(0, EXAMPLE_CHARS) },
      );
  const behalten = pick("signal");
  const noise = pick("noise");
  return behalten.length || noise.length ? { behalten, noise } : null;
}

// ---------- Entscheidung ----------

function decide(kind, c, s) {
  const p = c.p || {};
  const base = { source: "jev", pGehalt: p.gehalt, pBezug: p.bezug, pBait: p.koeder };
  if (c.override === "signal") return { ...base, collapse: false, reason: "von dir behalten" };
  if (c.override === "noise") return { ...base, collapse: true, reason: "von dir als Noise markiert" };
  if (Object.values(p).every((v) => typeof v !== "number")) return { ...base, collapse: false, reason: "nicht beantwortet" };

  const noGehalt = typeof p.gehalt === "number" && p.gehalt < s.gehaltThreshold;
  if (kind === "reply") {
    const noBezug = typeof p.bezug === "number" && p.bezug < s.bezugThreshold;
    const reason = noBezug && noGehalt ? "ohne Bezug und Gehalt" : noBezug ? "ohne Bezug zum Post" : noGehalt ? "ohne Gehalt" : "";
    return { ...base, collapse: noBezug || noGehalt, reason };
  }
  const bait =
    typeof p.koeder === "number" && p.koeder >= s.baitThreshold && !(typeof p.gehalt === "number" && p.gehalt >= BAIT_GEHALT_OVERRIDE);
  const reason = bait && noGehalt ? "Köder ohne Gehalt" : bait ? "Köder/Empörung" : noGehalt ? "ohne Gehalt" : "";
  return { ...base, collapse: bait || noGehalt, reason };
}

// Fehlt eine Antwort oder verweigert Jev, gilt sie als nicht beantwortet (bleibt sichtbar).
function readNoul(answer) {
  return answer && answer.type === "noul" && typeof answer.noul === "number" ? answer.noul : undefined;
}

// ---------- API ----------

function buildRequest(kind, post, items, examples, s) {
  const hint = examples ? EXAMPLE_HINT : "";
  const label = kind === "reply" ? "Antwort" : "Post";
  const prefix = kind === "reply" ? "r" : "p";
  const questions = {};
  items.forEach((_, i) => {
    for (const [name, q] of Object.entries(Q[kind])) {
      questions[`${prefix}${i}_${name}`] = {
        type: "noul",
        instructions: `${label} [${i}]: ${q.instructions}${hint}`,
        criteria: q.criteria,
      };
    }
  });
  let state;
  if (kind === "reply") {
    state = {
      post: post.text,
      post_autor: `@${post.author || ""}`,
      antworten: items.map((r, i) => ({ nr: i, autor: `@${r.author}`, text: r.text })),
    };
  } else {
    state = {
      posts: items.map((r, i) => {
        const o = { nr: i, autor: `@${r.author}`, text: r.text };
        if (r.quoted) o.zitiert = r.quoted.slice(0, 500);
        return o;
      }),
    };
  }
  if (examples) state.beispiele_leser = examples;
  return { model: s.model, state, questions };
}

async function postDecisions(body, s) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${s.apiBase}/api/alpha/decisions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get("Retry-After")) * 1000 || 800 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 8000)));
      continue;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${res.status} ${data?.error?.message || res.statusText}`);
    return data;
  }
  throw new Error("Rate-Limit oder Serverfehler, später erneut versuchen");
}

async function classifyBatch(kind, post, batch, examples, s) {
  const ts = Date.now();
  const out = {};
  const prefix = kind === "reply" ? "r" : "p";
  try {
    const data = await postDecisions(buildRequest(kind, post, batch, examples, s), s);
    const entries = batch.map((it, i) => {
      const p = {};
      for (const name of Object.keys(Q[kind])) p[name] = readNoul(data?.answers?.[`${prefix}${i}_${name}`]);
      const v = decide(kind, { p }, s);
      out[it.id] = v;
      return {
        kind, id: it.id, ts, author: it.author, text: it.text,
        postId: post?.id, postText: post?.text,
        p, collapse: v.collapse, reason: v.reason, model: data?.model || s.model, batch: batch.length,
      };
    });
    await saveBatch(entries, data?.usage);
  } catch (e) {
    const msg = String(e.message || e);
    await saveBatch([], null, msg);
    for (const it of batch) out[it.id] = { error: msg };
  }
  return out;
}

async function classify(kind, post, items) {
  if (kind !== "post" && kind !== "reply") return { error: "unbekannte Art" };
  const s = await getSettings();
  if (!s.apiKey) return { error: "Kein OpenRouter-Key gesetzt (Einstellungen öffnen)" };
  const { cache = {} } = await chrome.storage.local.get("cache");
  const results = {};
  const todo = [];
  for (const it of items) {
    const c = cache[`${kind}:${it.id}`];
    if (c) results[it.id] = { ...decide(kind, c, s), cached: true };
    else todo.push(it);
  }
  if (!todo.length) return { results };

  const examples = await getExamples(kind);
  const batches = [];
  for (let i = 0; i < todo.length; i += s.batchSize) batches.push(todo.slice(i, i + s.batchSize));
  let next = 0;
  const workers = Array.from({ length: Math.min(s.concurrency, batches.length) }, async () => {
    while (next < batches.length) {
      const b = batches[next++];
      Object.assign(results, await classifyBatch(kind, post, b, examples, s));
    }
  });
  await Promise.all(workers);
  return { results };
}

async function testKey() {
  const s = await getSettings();
  if (!s.apiKey) return { ok: false, error: "Kein Key gesetzt" };
  try {
    const data = await postDecisions(
      buildRequest(
        "post",
        null,
        [
          { author: "a", text: "Die EZB senkt den Leitzins um 0,25 Prozentpunkte auf 2,0 %, die dritte Senkung in diesem Jahr." },
          { author: "b", text: "Unglaublich, was DIE sich wieder erlauben!!! Wer ist auch so wütend? Like & teilen!" },
        ],
        null,
        s,
      ),
      s,
    );
    return { ok: true, answers: data.answers, usage: data.usage, model: data.model };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------- Diagnose: welche Fragestellung trennt am besten? ----------

const DIAG_EXAMPLES = [
  { soll: "gut", text: "Anthropic S-1, Seite 47: Umsatz-Run-Rate 9 Mrd $, Ausgabepreis 120 $, Lock-up 180 Tage. Bewertung damit etwa 40× Umsatz." },
  { soll: "gut", text: "Wir haben unsere CI von 40 auf 6 Minuten gebracht: Tests nach Laufzeit sharden, Docker-Layer cachen, Flaky-Tests in Quarantäne. Details im Thread." },
  { soll: "gut", text: "Destatis: Inflation im Oktober 2,1 %, Kerninflation 2,6 %. Dienstleistungen bleiben der Treiber, Energie dämpft." },
  { soll: "noise", text: "Anthropic ist so BÖSE!!! Erinnert ihr euch an das Paper von 2023?? Das müsst ihr JETZT teilen!!! 😡😡" },
  { soll: "noise", text: "Wer stimmt zu? Like wenn ja, RT wenn du auch so denkst 👇🔥" },
  { soll: "noise", text: "GM ☀️ Wer ist heute dabei? Drop a 🔥 below!" },
  { soll: "noise", text: "Ich verdiene 10.000 $ im Monat mit KI. Willst du wissen wie? Folge mir und kommentiere 'KI'." },
  { soll: "noise", text: "Unglaublich was hier gerade passiert. Das ändert alles. Niemand redet darüber. 🧵👇" },
];

const NEUTRAL = {
  gehalt: {
    type: "noul",
    instructions: "Enthält dieser Post konkrete, überprüfbare Information, eine nachvollziehbare Analyse oder einen begründeten Gedanken?",
    criteria: {
      true: "Ja: konkrete Fakten, Zahlen, Quellen, Erklärungen, Erfahrungen oder Argumente.",
      false: "Nein: Floskel, Stimmungsmache, Köder, Eigenwerbung oder Behauptung ohne jeden Inhalt.",
    },
  },
  koeder: {
    type: "noul",
    instructions: "Ist dieser Post hauptsächlich darauf angelegt, Empörung, Likes, Antworten oder Follows auszulösen, statt zu informieren?",
    criteria: {
      true: "Ja: Rage-Bait, Engagement-Köder, Clickbait ohne Auflösung, Aufwärmen alter Vorwürfe ohne neuen Anlass.",
      false: "Nein: informiert, erklärt, unterhält oder argumentiert.",
    },
  },
};

const CATEGORY = {
  kategorie: {
    type: "choice",
    instructions: "Welche Kategorie beschreibt diesen X-Post am besten?",
    criteria: {
      information: "Neue oder überprüfbare Information: Fakten, Zahlen, Quellen, Nachrichten mit Substanz.",
      analyse: "Erklärung, Analyse, Erfahrungsbericht oder begründete Meinung.",
      humor: "Witz, Meme oder Unterhaltung mit erkennbarer Pointe.",
      empoerung: "Empörung, Rage-Bait, Stimmungsmache, aufgewärmte Vorwürfe ohne neuen Anlass.",
      koeder: "Engagement-Köder oder Clickbait: 'Like wenn', 'Wer stimmt zu', 'Folge mir', Teaser ohne Inhalt.",
      leer: "Floskel, Gruß, Eigenwerbung oder Schlagwort ohne Inhalt.",
    },
  },
  gehalt: {
    type: "score",
    instructions: "Wie hoch ist der Informationsgehalt dieses Posts für einen interessierten Leser?",
    criteria: [
      "keiner: nichts Konkretes",
      "kaum: eine vage Behauptung",
      "etwas: ein konkreter Punkt",
      "deutlich: mehrere konkrete Fakten oder ein begründetes Argument",
      "hoch: dichte, neue, überprüfbare Information",
    ],
  },
};
const NOISE_CATS = ["empoerung", "koeder", "leer"];

async function diagnose() {
  const s = await getSettings();
  if (!s.apiKey) return { error: "Kein Key gesetzt" };
  const items = DIAG_EXAMPLES.map((e, i) => ({ id: `d${i}`, author: "beispiel", text: e.text }));
  let cost = 0;
  const one = async (questions, text) => {
    const d = await postDecisions({ model: s.model, state: text, questions }, s);
    cost += Number(d?.usage?.cost) || 0;
    return d.answers || {};
  };
  // A: aktuelle Variante (gebündelt, „im Zweifel behalten“)
  const a = await postDecisions(buildRequest("post", null, items, null, s), s);
  cost += Number(a?.usage?.cost) || 0;
  // B und C: ein Post pro Request
  const b = await Promise.all(items.map((it) => one(NEUTRAL, it.text)));
  const c = await Promise.all(items.map((it) => one(CATEGORY, it.text)));

  const rows = DIAG_EXAMPLES.map((e, i) => {
    const probs = c[i].kategorie?.probabilities || {};
    const pNoise = NOISE_CATS.reduce((sum, k) => sum + (Number(probs[k]) || 0), 0);
    return {
      soll: e.soll,
      text: e.text,
      A: { gehalt: readNoul(a.answers?.[`p${i}_gehalt`]), koeder: readNoul(a.answers?.[`p${i}_koeder`]) },
      B: { gehalt: readNoul(b[i].gehalt), koeder: readNoul(b[i].koeder) },
      C: { kategorie: c[i].kategorie?.choice, pNoise, score: c[i].gehalt?.score },
    };
  });
  // Trennschärfe: wie weit liegen „gut“ und „noise“ im Mittel auseinander (0 = gar nicht, 1 = perfekt)?
  const mean = (arr) => arr.reduce((x, y) => x + y, 0) / (arr.length || 1);
  const sep = (f) => {
    const g = rows.filter((r) => r.soll === "gut").map(f).filter((v) => typeof v === "number");
    const n = rows.filter((r) => r.soll === "noise").map(f).filter((v) => typeof v === "number");
    return mean(g) - mean(n);
  };
  const separation = {
    "A Gehalt": sep((r) => r.A.gehalt),
    "A Köder": -sep((r) => r.A.koeder),
    "B Gehalt": sep((r) => r.B.gehalt),
    "B Köder": -sep((r) => r.B.koeder),
    "C Kategorie": -sep((r) => r.C.pNoise),
    "C Gehalt-Skala": sep((r) => (typeof r.C.score === "number" ? r.C.score / 4 : undefined)),
  };
  return { ok: true, rows, separation, cost };
}

// ---------- Nachrichten ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "classify") sendResponse(await classify(msg.kind || "reply", msg.post, msg.items || msg.replies || []));
      else if (msg?.type === "feedback") { await saveFeedback(msg.id, msg.label); sendResponse({ ok: true }); }
      else if (msg?.type === "testKey") sendResponse(await testKey());
      else if (msg?.type === "diagnose") sendResponse(await diagnose().catch((e) => ({ error: String(e.message || e) })));
      else sendResponse({ error: "unbekannte Nachricht" });
    } catch (e) {
      sendResponse({ error: String(e?.message || e) });
    }
  })();
  return true;
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
