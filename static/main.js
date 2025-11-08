// --- CONFIG ---
// US Atlas TopoJSON (includes 118th Congress districts)
// Source: https://github.com/topojson/us-atlas (served via jsdelivr)
const US_ATLAS_CONGRESS =
  "https://cdn.jsdelivr.net/npm/us-atlas@3/congress-118.json";

// Map state postal -> numeric FIPS (for filtering TopoJSON)
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

// Leaflet map init
let map = null;
let geoLayer = null;
let currentGeo = null;

function initMap() {
  map = L.map("map", { minZoom: 3 }).setView([37.8, -96], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 10,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);
}

function styleDistrict(feature) {
  // Simple visual styling; color by district number parity just as a placeholder
  return {
    weight: 1,
    opacity: 0.9,
    color: "#333",
    fillOpacity: 0.3,
    fillColor: "#6699cc"
  };
}

function onEachDistrict(feature, layer) {
  const name = feature.properties && (feature.properties.district || feature.properties.dist || feature.properties.DISTRICT);
  const state = feature.properties && (feature.properties.state || feature.properties.STATEFP);
  layer.bindPopup(`<strong>District:</strong> ${name || "?"}<br/><strong>State:</strong> ${state || "?"}`);
}

async function loadStateMap(stateCode) {
  const fips = STATE_FIPS[stateCode];
  if (!fips) throw new Error(`Unknown state: ${stateCode}`);

  // Fetch TopoJSON once and keep it in memory
  if (!window.__US_CONGRESS_TOPO__) {
    const resp = await fetch(US_ATLAS_CONGRESS);
    if (!resp.ok) throw new Error("Failed to load congress topojson");
    window.__US_CONGRESS_TOPO__ = await resp.json();
  }

  const topo = window.__US_CONGRESS_TOPO__;
  // TopoJSON object for congressional districts is commonly named "districts"
  const objName = topo.objects && (topo.objects.districts || topo.objects.congress || Object.keys(topo.objects)[0]);
  const districts = topojson.feature(topo, objName);

  // Filter features to the selected state by STATEFP
  const filtered = {
    type: "FeatureCollection",
    features: districts.features.filter(f => {
      const st = (f.properties.STATEFP || f.properties.state || "").toString().padStart(2, "0");
      return st === fips;
    })
  };

  return filtered;
}

function renderGeojson(geojson) {
  if (geoLayer) {
    geoLayer.remove();
  }
  geoLayer = L.geoJSON(geojson, {
    style: styleDistrict,
    onEachFeature: onEachDistrict
  }).addTo(map);

  // Fit bounds to state
  try { map.fitBounds(geoLayer.getBounds(), { padding: [20, 20] }); } catch (_) {}
}

// --- Metrics + Classification (demo, replace with real data) ---
async function loadDemoMetrics(stateCode) {
  // Served from /api/metrics/STATE
  const resp = await fetch(`/api/metrics/${stateCode}`);
  if (!resp.ok) return null;
  return await resp.json();
}

function showMetrics(metrics) {
  const cls = document.getElementById("classification");
  const sum = document.getElementById("summary");
  const notes = document.getElementById("notes");

  cls.textContent = (metrics?.classification || "unknown").toUpperCase();

  const pretty = JSON.stringify(metrics?.summary || {}, null, 2);
  sum.textContent = pretty;

  notes.innerHTML = "";
  (metrics?.summary?.notes || []).forEach(n => {
    const li = document.createElement("li");
    li.textContent = n;
    notes.appendChild(li);
  });
}

// --- Generate alternative plan (placeholder) ---
async function generatePlan(stateCode, mode) {
  // For the initial MVP we just re-render the current map and update a note.
  // TODO: Replace with backend endpoint that returns new plan GeoJSON + metrics.
  const m = await loadDemoMetrics(stateCode);
  if (m && m.summary) {
    m.summary.notes = m.summary.notes || [];
    if (mode === "fair") {
      m.summary.notes.unshift("Generated fair plan (demo placeholder).");
      m.classification = "fair";
    } else if (mode === "favor_democrats") {
      m.summary.notes.unshift("Generated plan favoring Democrats (demo placeholder).");
      m.classification = "favors_democrats";
    } else if (mode === "favor_republicans") {
      m.summary.notes.unshift("Generated plan favoring Republicans (demo placeholder).");
      m.classification = "favors_republicans";
    }
    showMetrics(m);
  }
  // Re-render current map (no geometry change yet in demo)
  if (currentGeo) renderGeojson(currentGeo);
}

// --- Wire up UI ---
async function refreshState(stateCode) {
  // Load and render current map
  currentGeo = await loadStateMap(stateCode);
  renderGeojson(currentGeo);

  // Load & show demo classification
  const metrics = await loadDemoMetrics(stateCode);
  showMetrics(metrics);
}

window.addEventListener("DOMContentLoaded", async () => {
  initMap();

  const stateSelect = document.getElementById("stateSelect");
  const modeSelect = document.getElementById("modeSelect");
  const genBtn = document.getElementById("generateBtn");

  await refreshState(stateSelect.value);

  stateSelect.addEventListener("change", async () => {
    await refreshState(stateSelect.value);
  });

  genBtn.addEventListener("click", async () => {
    await generatePlan(stateSelect.value, modeSelect.value);
  });
});
