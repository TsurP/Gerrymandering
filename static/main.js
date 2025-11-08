// =====================
// INTERACTIVE NATIONWIDE + STATE DRILLDOWN
// =====================

// US Atlas TopoJSON endpoints
const US_ATLAS_CONGRESS =
  "https://cdn.jsdelivr.net/npm/us-atlas@3/congress-118.json";
const US_ATLAS_STATES_10M =
  "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json";

// State code <-> FIPS
const STATE_FIPS = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08",
  CT: "09", DE: "10", FL: "12", GA: "13", HI: "15", ID: "16",
  IL: "17", IN: "18", IA: "19", KS: "20", KY: "21", LA: "22",
  ME: "23", MD: "24", MA: "25", MI: "26", MN: "27", MS: "28",
  MO: "29", MT: "30", NE: "31", NV: "32", NH: "33", NJ: "34",
  NM: "35", NY: "36", NC: "37", ND: "38", OH: "39", OK: "40",
  OR: "41", PA: "42", RI: "44", SC: "45", SD: "46", TN: "47",
  TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54",
  WI: "55", WY: "56", DC: "11", PR: "72"
};
const FIPS_STATE = Object.fromEntries(Object.entries(STATE_FIPS).map(([k, v]) => [v, k]));

// Colors for bias
const COLORS = {
  favors_democrats: "#2563eb",  // blue
  favors_republicans: "#dc2626", // red
  fair: "#9ca3af",               // gray
  unknown: "#6b7280"             // darker gray
};

let map = null;
let statesLayer = null;
let geoLayer = null;       // current state's district layer
let currentGeo = null;     // current state's district geojson
let selectedState = null;  // e.g., "CA"
let METRICS_CACHE = {};    // { CA: {...}, TX: {...}, ... }

// ---------- Map init ----------
function initMap() {
  map = L.map("map", { minZoom: 3 }).setView([37.8, -96], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 10,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);
}

// ---------- Metrics helpers ----------
async function loadMetrics(stateCode) {
  if (METRICS_CACHE[stateCode]) return METRICS_CACHE[stateCode];
  try {
    const resp = await fetch(`/api/metrics/${stateCode}`);
    if (resp.ok) {
      const data = await resp.json();
      METRICS_CACHE[stateCode] = data;
      return data;
    }
  } catch (_) {}
  METRICS_CACHE[stateCode] = { classification: "unknown", summary: { notes: ["No metrics"] } };
  return METRICS_CACHE[stateCode];
}

// prefetch a few popular states (optional)
async function warmMetricsCache(codes = ["CA", "TX", "FL", "NY", "PA", "IL"]) {
  await Promise.all(codes.map(loadMetrics));
}

// ---------- Nationwide states layer ----------
async function addStatesLayer() {
  // Fetch and convert states topojson
  if (!window.__US_STATES_TOPO__) {
    const resp = await fetch(US_ATLAS_STATES_10M);
    if (!resp.ok) throw new Error("Failed to load states topojson");
    window.__US_STATES_TOPO__ = await resp.json();
  }
  const topo = window.__US_STATES_TOPO__;
  const objectName = topo.objects.states || Object.keys(topo.objects)[0];
  const statesFC = topojson.feature(topo, objectName);

  function getStateCodeFromFeature(f) {
    const fp = (f.properties?.state || f.id || "").toString().padStart(2, "0");
    return FIPS_STATE[fp] || null;
  }

  async function stateStyle(feature) {
    const code = getStateCodeFromFeature(feature);
    let cls = "unknown";
    if (code) {
      const m = await loadMetrics(code);
      cls = (m?.classification || "unknown")
        .replace("favors_democrats", "favors_democrats")
        .replace("favors_republicans", "favors_republicans");
    }
    const isSelected = code && selectedState === code;
    return {
      weight: isSelected ? 2 : 1,
      color: isSelected ? "#ffffff" : "#111827",
      fillOpacity: 0.35,
      fillColor: COLORS[cls] || COLORS.unknown
    };
  }

  function stateStyleSync(feature) {
    // fast (non-async) first paint; updated on hover/click
    const code = getStateCodeFromFeature(feature);
    const cls = (METRICS_CACHE[code]?.classification) || "unknown";
    const isSelected = code && selectedState === code;
    return {
      weight: isSelected ? 2 : 1,
      color: isSelected ? "#ffffff" : "#111827",
      fillOpacity: 0.35,
      fillColor: COLORS[cls] || COLORS.unknown
    };
  }

  function onEachState(feature, layer) {
    const code = getStateCodeFromFeature(feature);
    const name = feature.properties?.name || code || "State";

    layer.bindTooltip(name, { sticky: true, direction: "top" });

    layer.on("mouseover", async () => {
      layer.setStyle({ weight: 2, color: "#ffffff" });
      const m = code ? await loadMetrics(code) : null;
      const classification = (m?.classification || "unknown").replace("_", " ");
      layer.setTooltipContent(`${name} — ${classification.toUpperCase()}`);
      // update legend pill color
      updateHoverPill(code, m?.classification || "unknown");
    });

    layer.on("mouseout", () => {
      // reset to cached style
      layer.setStyle(stateStyleSync(feature));
      updateHoverPill(null, null);
    });

    layer.on("click", async () => {
      if (!code) return;
      selectedState = code;
      // reflect in dropdown
      const sel = document.getElementById("stateSelect");
      if (sel) sel.value = code;
      // refresh the state view (loads districts; zooms)
      await refreshState(code);
      // visually bump the selected state
      statesLayer.eachLayer(l => {
        l.setStyle(stateStyleSync(l.feature));
      });
    });
  }

  statesLayer = L.geoJSON(statesFC, {
    style: stateStyleSync,
    onEachFeature: onEachState
  }).addTo(map);
}

// ---------- Districts (per state) ----------
function styleDistrictBase() {
  return {
    weight: 1,
    opacity: 0.9,
    color: "#333",
    dashArray: null,
    fillOpacity: 0.30,
    fillColor: "#6699cc"
  };
}

function styleDistrictMode(mode) {
  // Visual cue to indicate the *generated* plan changed things
  if (mode === "favor_democrats") {
    return {
      color: "#1e3a8a",
      fillColor: "#60a5fa",
      fillOpacity: 0.35,
      weight: 2,
      dashArray: "3 3"
    };
  }
  if (mode === "favor_republicans") {
    return {
      color: "#7f1d1d",
      fillColor: "#f87171",
      fillOpacity: 0.35,
      weight: 2,
      dashArray: "3 3"
    };
  }
  // fair
  return {
    color: "#065f46",
    fillColor: "#34d399",
    fillOpacity: 0.35,
    weight: 2,
    dashArray: "2 4"
  };
}

function onEachDistrict(feature, layer) {
  const dist =
    feature.properties?.district ||
    feature.properties?.dist ||
    feature.properties?.DISTRICT ||
    feature.properties?.CD118 ||
    "?";
  const st = feature.properties?.STATEFP || feature.properties?.state || "";
  layer.bindPopup(`<strong>District:</strong> ${dist}<br/><strong>STATEFP:</strong> ${st}`);
}

async function loadStateDistricts(stateCode) {
  const fips = STATE_FIPS[stateCode];
  if (!fips) throw new Error(`Unknown state: ${stateCode}`);

  if (!window.__US_CONGRESS_TOPO__) {
    const resp = await fetch(US_ATLAS_CONGRESS);
    if (!resp.ok) throw new Error("Failed to load congress topojson");
    window.__US_CONGRESS_TOPO__ = await resp.json();
  }
  const topo = window.__US_CONGRESS_TOPO__;
  const objName = topo.objects?.districts || topo.objects?.congress || Object.keys(topo.objects)[0];
  const districts = topojson.feature(topo, objName);

  const filtered = {
    type: "FeatureCollection",
    features: districts.features.filter(f => {
      const st = (f.properties.STATEFP || f.properties.state || "").toString().padStart(2, "0");
      return st === fips;
    })
  };
  return filtered;
}

function renderDistricts(geojson, style = styleDistrictBase()) {
  if (geoLayer) geoLayer.remove();
  geoLayer = L.geoJSON(geojson, {
    style: () => style,
    onEachFeature: onEachDistrict
  }).addTo(map);
  try {
    map.fitBounds(geoLayer.getBounds(), { padding: [18, 18] });
  } catch (_) {}
}

// ---------- Sidebar + legend ----------
function showMetrics(metrics) {
  const cls = document.getElementById("classification");
  const sum = document.getElementById("summary");
  const notes = document.getElementById("notes");

  const c = (metrics?.classification || "unknown").toUpperCase();
  cls.textContent = c;
  cls.style.background = (COLORS[metrics?.classification] || COLORS.unknown);
  cls.style.color = "#fff";
  cls.style.display = "inline-block";
  cls.style.padding = "2px 8px";
  cls.style.borderRadius = "999px";

  sum.textContent = JSON.stringify(metrics?.summary || {}, null, 2);

  notes.innerHTML = "";
  (metrics?.summary?.notes || []).forEach(n => {
    const li = document.createElement("li");
    li.textContent = n;
    notes.appendChild(li);
  });
}

function updateHoverPill(stateCode, classification) {
  const pill = document.getElementById("hoverPill");
  if (!pill) return;
  if (!stateCode) {
    pill.style.display = "none";
    return;
  }
  pill.style.display = "inline-block";
  pill.textContent = `${stateCode} — ${(classification || "unknown").replace("_", " ").toUpperCase()}`;
  pill.style.background = (COLORS[classification] || COLORS.unknown);
  pill.style.color = "#fff";
}

// ---------- Actions ----------
async function refreshState(stateCode) {
  selectedState = stateCode;
  // Load districts + render
  currentGeo = await loadStateDistricts(stateCode);
  renderDistricts(currentGeo, styleDistrictBase());

  // Load & show metrics
  const metrics = await loadMetrics(stateCode);
  showMetrics(metrics);
}

async function generatePlan(stateCode, mode) {
  // Placeholder visual cue for "new plan"
  // When your backend is ready, fetch /map/generate here and render that geojson instead.
  if (!currentGeo) return;

  // Update metrics notes & classification to reflect generation intent (demo)
  const m = await loadMetrics(stateCode);
  m.summary = m.summary || {};
  m.summary.notes = m.summary.notes || [];
  if (mode === "fair") {
    m.summary.notes.unshift("Generated fair plan (demo).");
    m.classification = "fair";
  } else if (mode === "favor_democrats") {
    m.summary.notes.unshift("Generated plan favoring Democrats (demo).");
    m.classification = "favors_democrats";
  } else {
    m.summary.notes.unshift("Generated plan favoring Republicans (demo).");
    m.classification = "favors_republicans";
  }
  showMetrics(m);

  // Re-render districts with a distinct style to indicate “changed” plan
  renderDistricts(currentGeo, styleDistrictMode(mode));
}

// ---------- Bootstrap ----------
window.addEventListener("DOMContentLoaded", async () => {
  initMap();
  await warmMetricsCache();   // optional, speeds up hover colors
  await addStatesLayer();

  // wire controls
  const stateSelect = document.getElementById("stateSelect");
  const modeSelect = document.getElementById("modeSelect");
  const genBtn = document.getElementById("generateBtn");

  // initial: use dropdown’s default
  selectedState = stateSelect.value;
  await refreshState(selectedState);

  stateSelect.addEventListener("change", async () => {
    await refreshState(stateSelect.value);
    // also visually reflect selection on the nationwide layer
    statesLayer.eachLayer(l => l.setStyle(l.feature ? {
      ...l.options.style, ...{ weight: (FIPS_STATE[l.feature.id] === stateSelect.value ? 2 : 1), color: (FIPS_STATE[l.feature.id] === stateSelect.value ? "#ffffff" : "#111827") }
    } : {});
  });

  genBtn.addEventListener("click", async () => {
    await generatePlan(stateSelect.value, modeSelect.value);
  });
});
