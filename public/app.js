const $ = (s) => document.querySelector(s);
const state = { rows: [], q: "", source: "", category: "", date: "", amount: "" };
const cfg = window.__FIREBASE_CONFIG__ || null;

function esc(v) { return String(v ?? "").toLowerCase(); }
function html(v) { return String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function amtClass(c) { return c === "Webinar" ? "amt-webinar" : c === "Bundle" ? "amt-bundle" : c === "Course" ? "amt-course" : ""; }

function renderOptions(id, values) {
  const el = $(id);
  for (const v of [...new Set(values)].filter(Boolean)) {
    const o = document.createElement("option");
    o.value = v; o.textContent = v; el.appendChild(o);
  }
}

async function loadFirestoreRows() {
  if (!cfg?.apiKey || !cfg?.projectId) return null;
  const [{ initializeApp }, { getFirestore, collection, getDocs, query, orderBy, limit }] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
  ]);
  const db = getFirestore(initializeApp(cfg));
  const snap = await getDocs(query(collection(db, "transactions"), orderBy("date", "desc"), limit(1000)));
  return snap.docs.map(d => normalize(d.data(), { transaction: d.id }));
}

async function loadLocalRows() {
  const res = await fetch("./data/transactions.json", { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : data.rows || [];
}

function normalize(raw = {}, fallback = {}) {
  return {
    transaction: String(raw.transaction || raw.payment_id || raw.id || fallback.transaction || ""),
    name: String(raw.name || raw.buyer_name || raw.buyer || fallback.name || ""),
    phone: String(raw.phone || raw.buyer_phone || fallback.phone || ""),
    email: String(raw.email || raw.buyer_email || fallback.email || ""),
    source: String(raw.source || "Instamojo"),
    category: String(raw.category || (Number(raw.amount) === 99 ? "Webinar" : Number(raw.amount) === 198 ? "Bundle" : Number(raw.amount) > 500 ? "Course" : "Other")),
    amount: Number(raw.amount || fallback.amount || 0),
    date: String(raw.date || fallback.date || ""),
    day: String(raw.day || fallback.day || ""),
    time: String(raw.time || fallback.time || ""),
  };
}

function render() {
  const rows = state.rows.filter(r => {
    const hay = Object.values(r).join(" ").toLowerCase();
    if (state.q && !hay.includes(state.q)) return false;
    if (state.source && r.source !== state.source) return false;
    if (state.category && r.category !== state.category) return false;
    if (state.date && r.date !== state.date) return false;
    if (state.amount) {
      const a = Number(r.amount);
      if (state.amount === "99" && a !== 99) return false;
      if (state.amount === "198" && a !== 198) return false;
      if (state.amount === "500+" && a <= 500) return false;
      if (state.amount === "other" && (a === 99 || a === 198 || a > 500)) return false;
    }
    return true;
  });
  $("#rows").innerHTML = rows.map(r => `<tr><td>${html(r.transaction)}</td><td>${html(r.name)}</td><td>${html(r.phone)}</td><td>${html(r.email)}</td><td>${html(r.source)}</td><td>${html(r.category)}</td><td class="${amtClass(r.category)}">${html(r.amount)}</td><td>${html(r.date)}</td><td>${html(r.day)}</td><td>${html(r.time)}</td></tr>`).join("");
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const c = k => rows.filter(r => r.category === k).length;
  $("#stats").innerHTML = [
    ["Rows", rows.length], ["Revenue", `₹${total}`], ["Webinar", c("Webinar")], ["Course", c("Course")]
  ].map(([l, v]) => `<div class="card"><div class="label">${l}</div><div class="value">${v}</div></div>`).join("");
}

["#q","#source","#category","#date","#amount"].forEach(id => {
  const el = $(id);
  ["input", "change"].forEach(evt => el.addEventListener(evt, e => { state[id.slice(1)] = e.target.value; render(); }));
});

async function init() {
  try {
    const rows = await loadFirestoreRows() || await loadLocalRows();
    state.rows = rows;
    $("#status").textContent = cfg?.apiKey ? "Firestore loaded." : rows.length ? "Static data loaded." : "No data connected yet.";
  } catch (e) {
    state.rows = [];
    $("#status").textContent = `No transactions loaded (${e.message || e}).`;
  }
  renderOptions("#source", state.rows.map(r => r.source));
  renderOptions("#category", state.rows.map(r => r.category));
  renderOptions("#date", state.rows.map(r => r.date));
  render();
}
init();

$("#load").addEventListener("click", async () => {
  const raw = $("#import").value.trim();
  if (!raw) return;
  try {
    const body = JSON.parse(raw);
    const rows = Array.isArray(body) ? body : [body];
    if (cfg?.apiKey && cfg?.projectId) {
      const [{ initializeApp }, { getFirestore, collection, addDoc }] = await Promise.all([
        import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
        import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
      ]);
      const db = getFirestore(initializeApp(cfg));
      for (const r of rows) await addDoc(collection(db, "transactions"), normalize(r, r));
      $("#importStatus").textContent = `Saved ${rows.length} rows to Firestore.`;
    } else {
      const res = await fetch("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }) });
      const out = await res.json();
      $("#importStatus").textContent = `Saved ${out.count} rows locally.`;
    }
    init();
  } catch {
    $("#importStatus").textContent = "Invalid JSON.";
  }
});
