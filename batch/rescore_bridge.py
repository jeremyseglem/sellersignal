#!/usr/bin/env python3
"""
Python-to-Node bridge for validating scoreParcelNew against real Supabase data.

Pulls parcels + investigation_cache via urllib (which works in sandbox),
pipes them to `node batch/score-stdin.js` via subprocess (which does NOT
need network), then compares the new scores against the current parcel_scores
rows in the database.

NO WRITES. Read-only validation. No SerpAPI calls.

Usage:
  python3 batch/rescore_bridge.py 85253
  python3 batch/rescore_bridge.py 85253 98004 37215
"""
import sys, os, json, urllib.request, subprocess
from pathlib import Path

SB = "https://eeqsbvizgpuehphiaslo.supabase.co"
KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVlcXNidml6Z3B1ZWhwaGlhc2xvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTI4NzIyNCwiZXhwIjoyMDg0ODYzMjI0fQ.6ywoR4WVGJasJswXyZOGpv1HgPrXU9IEKkCWe9Ux_iQ"
REPO = Path(__file__).parent.parent

def sb(path):
    req = urllib.request.Request(f"{SB}/rest/v1/{path}", headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())

def db_parcel_to_score_input(row):
    """
    Map a parcels-table row to the shape scoreParcelNew expects.
    Matches dbParcelToScoreInput() in rescore-with-signals.js exactly.
    """
    return {
        "id": row["id"],
        "ownerName": row.get("owner_name") or "",
        "address": row.get("address") or "",
        "cityStateZip": "",
        "totalValue": row.get("assessed_value") or 0,
        "buildingValue": row.get("building_value") or 0,
        "landValue": row.get("land_value") or 0,
        "ownerAddress": row.get("mailing_address") or "",
        "ownerCity": row.get("mailing_city") or "",
        "ownerState": row.get("mailing_state") or row.get("owner_state") or "",
        "ownerZip": row.get("mailing_zip") or "",
        "isAbsentee": row.get("is_absentee") or False,
        "isOutOfState": row.get("is_out_of_state") or False,
        "mailDiffers": row.get("is_absentee") or False,
        "propType": row.get("prop_type") or "",
        "isVacant": row.get("is_vacant_land") or False,
        "lat": row.get("lat") or 0,
        "lng": row.get("lng") or 0,
        "acres": row.get("acres") or 0,
        "yearBuilt": row.get("year_built"),
        "livingSpace": row.get("sqft") or 0,
        "bedrooms": row.get("bedrooms") or 0,
        "exempt": False,
        "subdivision": row.get("subdivision") or "",
        "multiCount": row.get("multi_count") or 1,
        "lastTransferYear": row.get("last_transfer_year"),
        "lastTransferDate": row.get("last_transfer_date"),
        "salePrice": row.get("sale_price"),
        "tenureYears": row.get("tenure_years"),
        "tenureSource": "deed" if row.get("last_transfer_date") else None,
        "tenureConfidence": "high" if row.get("tenure_years") is not None else None,
        "tenureLongTerm": (row.get("tenure_years") is None) or (row.get("tenure_years") >= 3),
        "quitClaimFlag": False,
    }

def score_batch(parcels, signals_by_id):
    """Pipe to node score-stdin.js and return the list of result objects."""
    payload = json.dumps({
        "parcels": parcels,
        "signalsByParcelId": signals_by_id,
    })
    result = subprocess.run(
        ["node", str(REPO / "batch" / "score-stdin.js")],
        input=payload,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        print(f"Scorer failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(result.stdout)

def fetch_all_parcels(zip_code):
    """Paginated fetch of all parcels for a ZIP."""
    all_rows = []
    offset = 0
    page_size = 1000
    while True:
        rows = sb(f"parcels?zip_code=eq.{zip_code}&select=*&offset={offset}&limit={page_size}")
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < page_size:
            break
        offset += page_size
    return all_rows

def process_zip(zip_code):
    print(f"\n{'='*130}")
    print(f"ZIP {zip_code}")
    print('='*130)
    
    # Pull parcels
    parcels_raw = fetch_all_parcels(zip_code)
    print(f"  Loaded {len(parcels_raw)} parcels")
    if not parcels_raw:
        return
    
    # Pull investigation_cache (skip _listingOnly)
    inv_raw = sb(f"investigation_cache?zip_code=eq.{zip_code}&select=parcel_id,signals,enhanced_claims&limit=2000")
    signals_by_id = {}
    listing_only_skipped = 0
    for r in inv_raw:
        ec = r.get("enhanced_claims") or {}
        if ec.get("_listingOnly"):
            listing_only_skipped += 1
            continue
        signals_by_id[r["parcel_id"]] = r.get("signals") or []
    print(f"  Investigation: {len(signals_by_id)} full + {listing_only_skipped} listing-only (skipped)")
    
    # Pull existing parcel_scores for comparison
    old_scores_raw = sb(f"parcel_scores?zip_code=eq.{zip_code}&select=parcel_id,briefing_rank,seller_likelihood,cohort&limit=50000")
    old_by_id = {s["parcel_id"]: s for s in old_scores_raw}
    print(f"  Existing scores: {len(old_by_id)}")
    
    # Convert parcels to score-input shape
    parcels_for_scoring = [db_parcel_to_score_input(r) for r in parcels_raw]
    
    # Batch score (chunked to avoid gigantic stdin buffers)
    print(f"  Scoring via node bridge...")
    all_results = []
    chunk_size = 500
    for i in range(0, len(parcels_for_scoring), chunk_size):
        chunk = parcels_for_scoring[i:i+chunk_size]
        chunk_ids = set(p["id"] for p in chunk)
        chunk_signals = {pid: signals_by_id[pid] for pid in signals_by_id if pid in chunk_ids}
        results = score_batch(chunk, chunk_signals)
        all_results.extend(results)
    
    print(f"  Scored {len(all_results)} parcels")
    
    # Build lookup tables for comparison
    new_by_id = {r["parcel_id"]: r for r in all_results}
    parcel_by_id = {r["id"]: r for r in parcels_raw}
    
    # Summary stats
    agents = sum(1 for r in all_results if r["cohort"] == "agent")
    recent_buyers = sum(1 for r in all_results if r["cohort"] == "recent_buyer")
    commercial = sum(1 for r in all_results if r["cohort"] == "commercial")
    institutional = sum(1 for r in all_results if r["cohort"] in ("institutional",))
    top_sl = sum(1 for r in all_results if r["seller_likelihood"] >= 55)
    mid_sl = sum(1 for r in all_results if 35 <= r["seller_likelihood"] < 55)
    has_inv = sum(1 for r in all_results if r["has_investigation"])
    
    print(f"\n  New scoring summary:")
    print(f"    with investigation data:    {has_inv}")
    print(f"    blocked — agents:           {agents}")
    print(f"    blocked — recent buyers:    {recent_buyers}")
    print(f"    blocked — commercial:       {commercial}")
    print(f"    sellerLikelihood >= 55:     {top_sl}")
    print(f"    sellerLikelihood 35-54:     {mid_sl}")
    
    # Sort new results descending by briefing_rank
    sorted_new = sorted(all_results, key=lambda r: (-r["briefing_rank"], -r["seller_likelihood"]))
    
    # Sort old results descending
    sorted_old = sorted(old_scores_raw, key=lambda s: -(s.get("briefing_rank") or 0))
    
    # Display new top 20
    print(f"\n  NEW TOP 20 (investigation-driven):")
    print(f"  {'#':<3} {'inv':<4} {'new':<5} {'sl':<4} {'old':<5} {'owner':<38} {'val':<11} {'cohort':<20} top_signal")
    for i, r in enumerate(sorted_new[:20]):
        p = parcel_by_id.get(r["parcel_id"], {})
        old = old_by_id.get(r["parcel_id"], {})
        val = p.get("assessed_value") or 0
        val_s = f"${val/1e6:.1f}M" if val >= 1e6 else (f"${val/1e3:.0f}K" if val > 0 else "?")
        owner = (p.get("owner_name") or "?")[:37]
        top_sig = ""
        if r.get("signals"):
            top_sig = (r["signals"][0].get("text") or "")[:60]
        inv_flag = "✓" if r["has_investigation"] else " "
        print(f"  {i+1:<3} {inv_flag:<4} {r['briefing_rank']:<5} {r['seller_likelihood']:<4} {old.get('briefing_rank',0):<5} {owner:<38} {val_s:<11} {r['cohort'][:19]:<20} {top_sig}")
    
    # Display old top 20 with their new score
    print(f"\n  OLD TOP 20 (property-shape) — showing where they moved:")
    print(f"  {'#':<3} {'old':<5} {'new':<5} {'Δ':<6} {'owner':<38} {'val':<11} {'new_cohort':<20}")
    for i, s in enumerate(sorted_old[:20]):
        pid = s["parcel_id"]
        p = parcel_by_id.get(pid, {})
        new = new_by_id.get(pid, {})
        old_rank = s.get("briefing_rank") or 0
        new_rank = new.get("briefing_rank") or 0
        delta = new_rank - old_rank
        delta_s = f"+{delta}" if delta > 0 else str(delta)
        val = p.get("assessed_value") or 0
        val_s = f"${val/1e6:.1f}M" if val >= 1e6 else (f"${val/1e3:.0f}K" if val > 0 else "?")
        owner = (p.get("owner_name") or "?")[:37]
        print(f"  {i+1:<3} {old_rank:<5} {new_rank:<5} {delta_s:<6} {owner:<38} {val_s:<11} {new.get('cohort','?')[:19]:<20}")
    
    # Key movers — biggest UPWARD shifts (parcels that moved INTO the top)
    movers = []
    for r in all_results:
        pid = r["parcel_id"]
        old_rank = (old_by_id.get(pid, {}) or {}).get("briefing_rank") or 0
        new_rank = r["briefing_rank"]
        if new_rank >= 50 and new_rank - old_rank >= 10:
            movers.append((pid, old_rank, new_rank, r))
    movers.sort(key=lambda x: -(x[2] - x[1]))
    
    if movers:
        print(f"\n  BIGGEST UPWARD MOVERS (parcels that moved INTO the top):")
        print(f"  {'old':<5} {'→':<3} {'new':<5} {'Δ':<6} {'owner':<38} {'cohort':<20} top_signal")
        for pid, old, new_rank, r in movers[:10]:
            p = parcel_by_id.get(pid, {})
            owner = (p.get("owner_name") or "?")[:37]
            delta = new_rank - old
            top_sig = ""
            if r.get("signals"):
                top_sig = (r["signals"][0].get("text") or "")[:60]
            print(f"  {old:<5} {'→':<3} {new_rank:<5} +{delta:<5} {owner:<38} {r['cohort'][:19]:<20} {top_sig}")

def main():
    zips = sys.argv[1:]
    if not zips:
        zips = ["85253", "98004", "37215", "28207", "59715", "33480"]
        print(f"No ZIPs specified, using defaults: {zips}")
    
    for z in zips:
        try:
            process_zip(z)
        except Exception as e:
            import traceback
            print(f"\nZIP {z} FAILED: {e}")
            traceback.print_exc()

if __name__ == "__main__":
    main()
