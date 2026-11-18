"use strict";

const DEFAULTS = {
  apiKey: "",
  model: "typesafe/jev-1.14",
  enabled: true,
  filterFeed: true,
  filterReplies: false,
  debug: false,
  gehaltThreshold: 0.4,
  baitThreshold: 0.75,
  bezugThreshold: 0.35,
};
const CHECKS = ["enabled", "filterFeed", "filterReplies", "debug"];
const SLIDERS = [["gehaltThreshold", "gehaltVal"], ["baitThreshold", "baitVal"], ["bezugThreshold", "bezugVal"]];

const $ = (id) => document.getElementById(id);

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = kind;
}

function fmtPct(v) {
  return `${Math.round(Number(v) * 100)} %`;
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $("apiKey").value = s.apiKey;
  $("model").value = s.model;
  for (const id of CHECKS) $(id).checked = s[id] === true;
  for (const [id, label] of SLIDERS) {
    $(id).value = s[id];
    $(label).textContent = fmtPct(s[id]);
  }
  await renderStats();
}

async function renderStats() {
  const { stats = { calls: 0, cost: 0, errors: 0 }, log = [] } = await chrome.storage.local.get(["stats", "log"]);
  const collapsed = log.filter((e) => e.collapse);
  const wrong = collapsed.filter((e) => e.feedback === "signal").length;
  const missed = log.filter((e) => !e.collapse && e.feedback === "noise").length;
  const rows = [
    ["Bewertete Antworten", stats.calls || 0],
    ["API-Requests (gebündelt)", stats.requests || 0],
    ["Kosten laut OpenRouter", `$${Number(stats.cost).toFixed(5)}`],
    ["Fehler", stats.errors],
    ["Eingeklappt", collapsed.length],
    ["davon als falsch markiert", wrong],
    ["Übersehenes Noise (markiert)", missed],
  ];
  const dl = $("stats");
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = String(v);
    dl.append(dt, dd);
  }
}

$("save").addEventListener("click", async () => {
  try {
    await chrome.storage.local.set({
      apiKey: $("apiKey").value.trim(),
      model: $("model").value.trim() || DEFAULTS.model,
    });
    setStatus("Gespeichert.", "ok");
  } catch (e) {
    setStatus(`Speichern fehlgeschlagen: ${e.message}`, "err");
  }
});

$("test").addEventListener("click", async () => {
  setStatus("Teste …");
  try {
    await chrome.storage.local.set({
      apiKey: $("apiKey").value.trim(),
      model: $("model").value.trim() || DEFAULTS.model,
    });
    const r = await chrome.runtime.sendMessage({ type: "testKey" });
    if (r?.ok) {
      const a = r.answers || {};
      const p = (k) => (typeof a[k]?.noul === "number" ? fmtPct(a[k].noul) : "–");
      setStatus(
        `Verbindung ok (${r.model}).\n` +
          `Sachlicher Testpost: Gehalt ${p("p0_gehalt")}, Köder ${p("p0_koeder")}\n` +
          `Empörungs-Testpost: Gehalt ${p("p1_gehalt")}, Köder ${p("p1_koeder")}\n` +
          `Kosten $${Number(r.usage?.cost ?? 0).toFixed(7)}`,
        "ok",
      );
      await renderStats();
    } else {
      setStatus(`Fehler: ${r?.error || "unbekannt"}`, "err");
    }
  } catch (e) {
    setStatus(`Fehler: ${e.message}`, "err");
  }
});

for (const id of CHECKS) {
  $(id).addEventListener("change", (ev) => chrome.storage.local.set({ [id]: ev.target.checked }));
}

for (const [id, label] of SLIDERS) {
  $(id).addEventListener("input", (ev) => {
    $(label).textContent = fmtPct(ev.target.value);
  });
  $(id).addEventListener("change", (ev) => chrome.storage.local.set({ [id]: Number(ev.target.value) }));
}

function cell(tr, text, cls = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  tr.append(td);
}

const pctOr = (v) => (typeof v === "number" ? fmtPct(v) : "–");

$("diagnose").addEventListener("click", async () => {
  const st = $("diagStatus");
  st.className = "";
  st.textContent = "Läuft … (17 Requests)";
  $("diagOut").replaceChildren();
  try {
    await chrome.storage.local.set({ apiKey: $("apiKey").value.trim(), model: $("model").value.trim() || DEFAULTS.model });
    const r = await chrome.runtime.sendMessage({ type: "diagnose" });
    if (!r?.ok) throw new Error(r?.error || "unbekannt");

    const best = Object.entries(r.separation).sort((a, b) => b[1] - a[1])[0][0];
    st.textContent = `Fertig. Kosten $${r.cost.toFixed(6)}. Trennschärfe: Abstand der Mittelwerte zwischen gut und Noise (0 = trennt nicht, 1 = perfekt).`;

    const sepTable = document.createElement("table");
    sepTable.className = "diag";
    const head = document.createElement("tr");
    for (const h of ["Variante", "Trennschärfe"]) {
      const th = document.createElement("th");
      th.textContent = h;
      head.append(th);
    }
    sepTable.append(head);
    for (const [k, v] of Object.entries(r.separation)) {
      const tr = document.createElement("tr");
      cell(tr, k, k === best ? "best" : "");
      cell(tr, Number.isFinite(v) ? v.toFixed(2) : "–", k === best ? "best" : "");
      sepTable.append(tr);
    }

    const t = document.createElement("table");
    t.className = "diag wide";
    const h2 = document.createElement("tr");
    for (const h of ["Beispiel", "A Gehalt", "A Köder", "B Gehalt", "B Köder", "C Kategorie", "C Noise", "C Skala 0–4"]) {
      const th = document.createElement("th");
      th.textContent = h;
      h2.append(th);
    }
    t.append(h2);
    for (const row of r.rows) {
      const tr = document.createElement("tr");
      tr.className = row.soll;
      cell(tr, `${row.soll === "gut" ? "✓" : "✗"} ${row.text.slice(0, 60)}…`);
      cell(tr, pctOr(row.A.gehalt));
      cell(tr, pctOr(row.A.koeder));
      cell(tr, pctOr(row.B.gehalt));
      cell(tr, pctOr(row.B.koeder));
      cell(tr, row.C.kategorie || "–");
      cell(tr, pctOr(row.C.pNoise));
      cell(tr, typeof row.C.score === "number" ? row.C.score.toFixed(1) : "–");
      t.append(tr);
    }
    const legend = document.createElement("p");
    legend.className = "hint";
    legend.textContent =
      "A = aktuell (10 Posts gebündelt, „im Zweifel behalten“). B = ein Post pro Request, neutrale Ja/Nein-Fragen. C = ein Post pro Request, Kategorie-Auswahl plus Gehalt-Skala.";
    const w1 = document.createElement("div");
    w1.className = "diag-wrap";
    w1.append(sepTable);
    const w2 = document.createElement("div");
    w2.className = "diag-wrap";
    w2.append(t);
    $("diagOut").append(w1, w2, legend);
  } catch (e) {
    st.className = "err";
    st.textContent = `Fehler: ${e.message}`;
  }
});

$("export").addEventListener("click", async () => {
  const { log = [] } = await chrome.storage.local.get("log");
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `noisefilter-protokoll-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("clear").addEventListener("click", async () => {
  await chrome.storage.local.remove(["cache", "log", "stats"]);
  setStatus("Cache und Protokoll gelöscht.", "ok");
  await renderStats();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ("stats" in changes || "log" in changes)) renderStats();
});

load();
