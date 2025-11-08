from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pathlib import Path
import csv, json
from typing import Dict, Any, List, Optional

# -------------------------
# Paths & App
# -------------------------
ROOT = Path(__file__).parent.resolve()
STATIC = ROOT / "static"
DATA = ROOT / "data"
DATA_ELECT = DATA / "elections"
DATA_POP = DATA / "population"
DATA_SHAPES = DATA / "shapes"   # reserved for per-state GeoJSON if/when you add them

app = FastAPI()
app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")

@app.get("/")
def root():
    return FileResponse(STATIC / "index.html")

@app.get("/health")
def health():
    return {"ok": True}

# -------------------------
# Utilities
# -------------------------
STATE_LIST = [
 "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
 "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK",
 "OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC","PR"
]

def read_csv(path: Path) -> List[Dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as f:
        return list(csv.DictReader(f))

def try_float(x) -> Optional[float]:
    try:
        return float(x)
    except Exception:
        return None

def default_summary() -> Dict[str, Any]:
    return {
        "pop_variance_pct": {"min": 0.0, "max": 0.0, "mean": 0.0},
        "compactness": {"mean_polsby_popper": None},  # will be computed once shapes are provided
        "expected_seats": {"dem": 0, "rep": 0},
        "notes": ["No real data found yet. Drop CSVs into /data to enable metrics."]
    }

def classify_from_expected(expected: Dict[str,int], statewide_vote_dem: Optional[float]) -> str:
    # If we know statewide vote share, a stricter rule would compare proportionality.
    # For a simple first pass, classify by which side leads expected seats.
    d = (expected or {}).get("dem", 0)
    r = (expected or {}).get("rep", 0)
    if d == 0 and r == 0:
        return "unknown"
    if d == r:
        return "fair"
    return "favors_democrats" if d > r else "favors_republicans"

# -------------------------
# Data loaders (plug real data here)
# -------------------------
def load_population_by_district(state: str) -> List[Dict[str, Any]]:
    """
    CSV schema (place at data/population/{STATE}.csv):

    district,population
    01,763121
    02,760998
    ...

    district is a 2-digit string matching district number (AL at-large can be 00 or 01).
    population is integer count (ACS or decennial).
    """
    rows = read_csv(DATA_POP / f"{state}.csv")
    out = []
    for r in rows:
        out.append({
            "district": str(r.get("district")),
            "population": int(float(r.get("population", 0) or 0))
        })
    return out

def load_election_results(state: str) -> List[Dict[str, Any]]:
    """
    CSV schema (place at data/elections/{STATE}.csv):

    district,dem_votes,rep_votes,total_votes
    01,180123,195221,378990
    02,210555,206201,420111
    ...

    Use last general, or a composite index; total_votes optional (computed if missing).
    """
    rows = read_csv(DATA_ELECT / f"{state}.csv")
    out = []
    for r in rows:
        dv = try_float(r.get("dem_votes"))
        rv = try_float(r.get("rep_votes"))
        tv = try_float(r.get("total_votes")) or ((dv or 0.0) + (rv or 0.0))
        out.append({
            "district": str(r.get("district")),
            "dem_votes": dv or 0.0,
            "rep_votes": rv or 0.0,
            "total_votes": tv or ((dv or 0.0) + (rv or 0.0))
        })
    return out

def load_state_shape_geojson(state: str) -> Optional[Dict[str, Any]]:
    """
    Optional: If you have per-state district GeoJSON, drop it at data/shapes/{STATE}.geo.json
    with a FeatureCollection of congressional districts with a 'district' property per feature.
    """
    p = DATA_SHAPES / f"{state}.geo.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None

# -------------------------
# Metric computations
# -------------------------
def compute_population_variance_pct(pop_rows: List[Dict[str, Any]]) -> Dict[str, float]:
    if not pop_rows:
        return {"min": 0.0, "max": 0.0, "mean": 0.0}
    pops = [r["population"] for r in pop_rows if r.get("population") is not None]
    if not pops:
        return {"min": 0.0, "max": 0.0, "mean": 0.0}
    target = sum(pops) / len(pops)  # ideal equal population
    pct = [((p - target) / target) * 100.0 for p in pops]
    return {"min": round(min(pct), 2), "max": round(max(pct), 2), "mean": round(sum(pct)/len(pct), 2)}

def compute_expected_seats(elec_rows: List[Dict[str, Any]]) -> Dict[str, int]:
    dem = 0
    rep = 0
    for r in elec_rows:
        if r["dem_votes"] > r["rep_votes"]:
            dem += 1
        elif r["rep_votes"] > r["dem_votes"]:
            rep += 1
        # ties are ignored
    return {"dem": dem, "rep": rep}

def compute_compactness_mean_pp(geojson: Optional[Dict[str, Any]]) -> Optional[float]:
    """
    Polsby–Popper = 4π * Area / Perimeter^2
    To compute this precisely you need polygon area & perimeter.
    If you provide data/shapes/{STATE}.geo.json, we compute a mean PP over districts using shapely.
    """
    if not geojson:
        return None
    try:
        from shapely.geometry import shape
    except Exception:
        return None

    import math
    vals = []
    for feat in geojson.get("features", []):
        try:
            geom = shape(feat.get("geometry"))
            area = geom.area
            perim = geom.length
            if perim > 0:
                pp = (4.0 * math.pi * area) / (perim * perim)
                vals.append(pp)
        except Exception:
            continue
    if not vals:
        return None
    return round(sum(vals)/len(vals), 3)

# -------------------------
# Demo seed (only used if no CSVs exist yet)
# -------------------------
DEMO = {
  "CA": {"classification":"favors_democrats","summary":{
      "pop_variance_pct":{"min":-0.9,"max":1.1,"mean":0.3},
      "compactness":{"mean_polsby_popper":0.36},
      "expected_seats":{"dem":34,"rep":19},
      "notes":["Demo-only metrics. Replace with Census + election data.","Coastal districts lean D; Central Valley more R."]
  }},
  "TX": {"classification":"favors_republicans","summary":{
      "pop_variance_pct":{"min":-0.8,"max":0.9,"mean":0.2},
      "compactness":{"mean_polsby_popper":0.31},
      "expected_seats":{"dem":13,"rep":25},
      "notes":["Demo-only metrics. Replace with Census + election data.","Suburban ring shows GOP advantage under current map."]
  }},
  "FL": {"classification":"favors_republicans","summary":{
      "pop_variance_pct":{"min":-0.7,"max":0.8,"mean":0.2},
      "compactness":{"mean_polsby_popper":0.33},
      "expected_seats":{"dem":8,"rep":20},
      "notes":["Demo-only metrics. Replace with Census + election data.","North FL and I-4 corridor decisive in seat outcomes."]
  }},
}

def compute_state_summary(state: str) -> Dict[str, Any]:
    # If you’ve already added CSVs/GeoJSON, compute from them:
    pop = load_population_by_district(state)
    elec = load_election_results(state)
    shp = load_state_shape_geojson(state)

    if pop or elec or shp:
        summary = default_summary()
        # population variance (if population provided)
        if pop:
            summary["pop_variance_pct"] = compute_population_variance_pct(pop)
        # expected seats (if elections provided)
        if elec:
            summary["expected_seats"] = compute_expected_seats(elec)
        # compactness from shapes, if available (requires shapely)
        pp = compute_compactness_mean_pp(shp)
        summary["compactness"]["mean_polsby_popper"] = pp
        # auto notes
        summary["notes"] = []
        if not pop: summary["notes"].append("No population CSV yet.")
        if not elec: summary["notes"].append("No elections CSV yet.")
        if shp is None: summary["notes"].append("No shapes GeoJSON yet (compactness unavailable).")

        classification = classify_from_expected(summary["expected_seats"], statewide_vote_dem=None)
        return {"classification": classification, "summary": summary}

    # else: use DEMO seed if present; otherwise unknown
    if state in DEMO:
        return DEMO[state]

    return {"classification": "unknown", "summary": default_summary()}

# -------------------------
# API: metrics for all (for nationwide coloring)
# -------------------------
@app.get("/api/metrics/all")
def metrics_all():
    out = {}
    for s in STATE_LIST:
        out[s] = compute_state_summary(s)
    return JSONResponse(out)

# -------------------------
# API: current map + metrics for a single state
# -------------------------
@app.get("/api/map/current")
def map_current(state: str = Query(..., min_length=2, max_length=2, description="Two-letter state code (e.g., CA)")):
    s = state.upper()
    summary = compute_state_summary(s)

    # If you place a GeoJSON at data/shapes/{STATE}.geo.json, we return it; else `geojson=None` (frontend already fetches geometry)
    geojson = load_state_shape_geojson(s)  # optional

    payload = {
        "state": s,
        "plan_type": "current",
        "summary": summary["summary"],
        "classification": summary["classification"],
        "geojson": geojson,   # will be null unless you add shapes
        "districts": []       # reserved for per-district metrics if you want to return them later
    }
    return JSONResponse(payload)
