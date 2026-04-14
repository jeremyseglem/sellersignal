#!/usr/bin/env python3
"""Execute the AZ_MARICOPA legacy parcel cleanup via Supabase PostgREST.
Runs the same safety checks as the SQL migration file, but works against
the REST API since we don't have direct SQL access from this environment.

Usage:
  export SUPABASE_SERVICE_KEY='...'
  python3 2026-04-13-cleanup-legacy-prefixed-parcels.py

Deletes orphan rows from pre-April 2 inline batch runner (see .sql file
in this directory for full history)."""

import os, urllib.request, urllib.parse, json, sys

SB = "https://eeqsbvizgpuehphiaslo.supabase.co"
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
if not KEY:
    print("SUPABASE_SERVICE_KEY env var required", file=sys.stderr)
    sys.exit(2)

def q(path, method='GET', body=None):
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
    if method == 'DELETE':
        headers["Prefer"] = "return=representation"
    elif body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{SB}/rest/v1/{path}", headers=headers, method=method)
    if body is not None:
        req.data = json.dumps(body).encode()
    r = urllib.request.urlopen(req, timeout=60)
    raw = r.read()
    return json.loads(raw) if raw else None

def qcount(path):
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}",
               "Prefer": "count=exact", "Range": "0-0"}
    req = urllib.request.Request(f"{SB}/rest/v1/{path}", headers=headers)
    r = urllib.request.urlopen(req, timeout=30)
    cr = r.headers.get('content-range', '0-0/0')
    return int(cr.split('/')[-1]) if '/' in cr else 0

print("=" * 70)
print("AZ_MARICOPA LEGACY PARCEL CLEANUP")
print("=" * 70)
print()

# --- SAFETY CHECK 1: confirm there are prefixed rows and they're broken ---
print("Step 1: Safety check — verify we're targeting the right data")
total_prefixed_85253 = qcount("parcels?zip_code=eq.85253&id=like.AZ_MARICOPA-*&select=id")
broken_prefixed_85253 = qcount("parcels?zip_code=eq.85253&id=like.AZ_MARICOPA-*&assessed_value=lt.100&assessed_value=gt.0&select=id")
print(f"  85253 prefixed rows: {total_prefixed_85253}")
print(f"  85253 prefixed broken (<$100): {broken_prefixed_85253}")
if total_prefixed_85253 == 0:
    print("  ❌ ABORT: no prefixed rows found. Migration already ran or data layout changed.")
    sys.exit(1)
broken_pct = 100 * broken_prefixed_85253 / total_prefixed_85253
print(f"  Broken percentage: {broken_pct:.1f}%")
if broken_pct < 30:
    print(f"  ❌ ABORT: only {broken_pct:.1f}% broken. Expected >30%. Safety guard triggered.")
    sys.exit(1)
print(f"  ✓ Safety check passed")
print()

# --- SAFETY CHECK 2: no investigation_cache entries will be cascade-deleted ---
print("Step 2: Verify no investigation_cache data will be lost")
inv_prefixed = qcount("investigation_cache?parcel_id=like.AZ_MARICOPA-*&select=parcel_id")
print(f"  investigation_cache entries with AZ_MARICOPA- prefix: {inv_prefixed}")
if inv_prefixed > 0:
    print(f"  ❌ ABORT: {inv_prefixed} investigation_cache rows would be cascade-deleted. Migrate them first.")
    sys.exit(1)
print(f"  ✓ No research data at risk")
print()

# --- SAFETY CHECK 3: confirm there are working naked rows for the same ZIP ---
print("Step 3: Verify 85253 has healthy naked-format data to fall back on")
naked_85253 = qcount("parcels?zip_code=eq.85253&id=not.like.AZ_MARICOPA-*&select=id")
working_85253 = qcount("parcels?zip_code=eq.85253&id=not.like.AZ_MARICOPA-*&assessed_value=gte.100000&select=id")
print(f"  85253 naked rows: {naked_85253}")
print(f"  85253 naked rows with assessed_value >= $100k: {working_85253}")
if naked_85253 < 5000:
    print(f"  ❌ ABORT: only {naked_85253} naked rows. Expected >5000. 85253 might not have been rescored.")
    sys.exit(1)
if working_85253 < naked_85253 * 0.5:
    print(f"  ❌ ABORT: only {working_85253}/{naked_85253} naked rows have values. Something's wrong.")
    sys.exit(1)
print(f"  ✓ Naked data is healthy — safe to delete prefixed orphans")
print()

# --- GET TOTAL COUNTS ACROSS ALL AZ_MARICOPA ZIPS ---
print("Step 4: Count total prefixed rows across all AZ_MARICOPA ZIPs")
# Query per ZIP to avoid timeout
az_zips = ['85253','85254','85262','85255','85268','85331','85251','85258','85260','85281','85224','85295','85206']
total_to_delete = 0
per_zip_counts = {}
for zc in az_zips:
    c = qcount(f"parcels?zip_code=eq.{zc}&id=like.AZ_MARICOPA-*&select=id")
    per_zip_counts[zc] = c
    total_to_delete += c
    print(f"    {zc}: {c} prefixed rows")
print(f"  Total to delete: {total_to_delete}")
print()

if total_to_delete == 0:
    print("Nothing to delete. Exiting.")
    sys.exit(0)

# --- EXECUTE DELETE PER ZIP ---
print("Step 5: Execute DELETE per ZIP (cascade will clean scores/deep_signals)")
print()
total_deleted = 0
for zc in az_zips:
    if per_zip_counts[zc] == 0:
        continue
    print(f"  Deleting {per_zip_counts[zc]} prefixed rows from {zc}...", end=" ", flush=True)
    try:
        result = q(f"parcels?zip_code=eq.{zc}&id=like.AZ_MARICOPA-*", method='DELETE')
        deleted = len(result) if result else 0
        total_deleted += deleted
        print(f"deleted {deleted}")
    except Exception as e:
        print(f"FAILED: {e}")
        sys.exit(1)

print()
print(f"Total deleted: {total_deleted}")
print()

# --- POST-CHECK ---
print("Step 6: Post-delete verification")
for zc in az_zips:
    remaining_prefixed = qcount(f"parcels?zip_code=eq.{zc}&id=like.AZ_MARICOPA-*&select=id")
    remaining_total = qcount(f"parcels?zip_code=eq.{zc}&select=id")
    broken_remaining = qcount(f"parcels?zip_code=eq.{zc}&assessed_value=lt.100&assessed_value=gt.0&select=id")
    print(f"  {zc}: {remaining_total} total, {remaining_prefixed} prefixed remaining, {broken_remaining} still broken")

print()
print("✓ CLEANUP COMPLETE")
