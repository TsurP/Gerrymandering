from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pathlib import Path
import json

app = FastAPI()

# Serve static files (HTML/JS/CSS)
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

@app.get("/")
def root():
    return FileResponse(static_dir / "index.html")

@app.get("/health")
def health():
    return {"ok": True}

# Simple API to expose demo metrics used for initial classification
@app.get("/api/metrics/{state_code}")
def metrics(state_code: str):
    """Return demo metrics for a state (extendable to all states).
    state_code = 2-letter uppercase, e.g., CA, TX, FL."""
    metrics_path = static_dir / "metrics_demo.json"
    try:
        data = json.loads(metrics_path.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    # Default fallback if state not present
    default = {
        "classification": "unknown",
        "summary": {
            "pop_variance_pct": {"min": None, "max": None, "mean": None},
            "compactness": {"mean_polsby_popper": None},
            "expected_seats": {"dem": None, "rep": None},
            "notes": ["No metrics available yet. Use TODO: populate metrics from real data."]
        }
    }
    return JSONResponse(data.get(state_code.upper(), default))
