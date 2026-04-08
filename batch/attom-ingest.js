// ============================================================================
// ATTOM SHADOW INGEST JOB
// ============================================================================
//
// Purpose: Pull a ZIP's worth of parcels from ATTOM, transform them to the
// SellerSignal schema, and write them to a NEW shadow table (attom_parcels)
// alongside the existing parcels table. Does NOT modify the production
// parcels table. Designed to run in parallel with the current worker.js
// during the ATTOM evaluation phase.
//
// Usage (once commercial ATTOM key is active):
//   node batch/attom-ingest.js 85253
//   node batch/attom-ingest.js 97702
//   node batch/attom-ingest.js 98040 --limit=500  (cap for testing)
//   node batch/attom-ingest.js 85253 --dry-run     (no DB writes)
//
// Before first run:
//   1. Set ATTOM_API_KEY environment variable
//   2. Run the schema migration at the bottom of this file in Supabase SQL editor
//   3. Start with small pageSize via --limit=100 to sanity check transformations
//   4. Once data looks clean, run full batches overnight in shadow mode
//
// What this job does NOT do (deliberately):
//   - Score parcels (no calls to inference.js, no parcel_scores writes)
//   - Update the production parcels table
//   - Touch zip_briefings, territory_claims, or any user-facing table
//   - Run Deep Signal enrichment (that's a separate integration)
//
// What this job DOES do:
//   - Pull property data from /property/detailmortgageowner
//   - For assessor-sparse states, pull AVM data from /attomavm/detail
//   - Transform to the SellerSignal parcel shape
//   - Write to attom_parcels (shadow table)
//   - Log field quality and transformation warnings
//
// Author: Built during pre-beta validation, Apr 8 2026
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const ATTOM_BASE = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';
const ATTOM_KEY = process.env.ATTOM_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// ============================================================================
// MARKET CLASSIFICATION
// ============================================================================
// States where ATTOM's statewide tax parcel feed does NOT populate values.
// For these, we need to make a second API call to /attomavm/detail to get
// usable property valuations. Validated against:
//   NY (10013 Tribeca)  — values $0, owner names also $0 (bigger problem)
//   MT (59937 Whitefish) — values $0, AVMs work at confidence 92-93
//   CO (81611 Aspen)    — values $0, AVMs expected to work
// Add new states to this list as you validate them.

const ASSESSOR_SPARSE_STATES = new Set(['NY', 'MT', 'CO']);

// States where owner names are systemically redacted in the ATTOM feed at
// rates high enough to skip entirely during Deep Signal enrichment.
// Currently empty — the one state we suspected (NY) actually has ~95% owner
// name coverage in ATTOM, measured against a 100-property sample in 10013
// Tribeca (95 populated, 4 suppressed, 1 blank). The 4% suppression rate
// is handled by the standard data quality filter (owner_name length check)
// and does not require special per-state treatment.
//
// Add states to this set only if validation sampling shows a suppression
// rate above roughly 20%, where filtering individually stops being
// cost-effective and the entire state should be routed differently.

const OWNER_REDACTED_STATES = new Set([]);

// ============================================================================
// CLI ARGS
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const zip = args.find(a => /^\d{5}$/.test(a));
  if (!zip) {
    console.error('Usage: node batch/attom-ingest.js <zip> [--limit=N] [--dry-run]');
    process.exit(1);
  }
  const limit = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10);
  const dryRun = args.includes('--dry-run');
  return { zip, limit, dryRun };
}

// ============================================================================
// ATTOM API WRAPPER
// ============================================================================

async function attomGet(path, params) {
  if (!ATTOM_KEY) throw new Error('ATTOM_API_KEY not set in environment');
  const url = new URL(`${ATTOM_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  
  const resp = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json', 'apikey': ATTOM_KEY },
    signal: AbortSignal.timeout(60000),
  });
  
  if (!resp.ok) {
    throw new Error(`ATTOM ${path} failed: HTTP ${resp.status} ${resp.statusText}`);
  }
  
  const data = await resp.json();
  const code = data?.status?.code;
  const msg = data?.status?.msg;
  
  if (code === 401) throw new Error('ATTOM API key is unauthorized — check ATTOM_API_KEY');
  if (code === 400) return { ...data, property: [] };  // success with no results
  if (code !== 0) throw new Error(`ATTOM ${path} returned code ${code}: ${msg}`);
  
  return data;
}

async function paginate(path, baseParams, onPage, maxParcels = 0) {
  let page = 1;
  let total = 0;
  const allProperties = [];
  
  while (true) {
    const params = { ...baseParams, page: String(page), pageSize: '100' };
    const data = await attomGet(path, params);
    const props = data.property || [];
    total = data.status?.total || 0;
    
    if (props.length === 0) break;
    allProperties.push(...props);
    
    if (onPage) onPage(page, props.length, total);
    
    if (maxParcels > 0 && allProperties.length >= maxParcels) {
      return allProperties.slice(0, maxParcels);
    }
    
    if (props.length < 100) break;
    if (page * 100 >= total) break;
    if (page >= 100) {
      console.warn(`  WARN: hit 100-page limit for ${path}, ATTOM caps at 10000 results per query`);
      break;
    }
    
    page += 1;
    await new Promise(r => setTimeout(r, 250));  // be polite to the API
  }
  
  return allProperties;
}

// ============================================================================
// TRANSFORM: ATTOM property → SellerSignal parcel
// ============================================================================
//
// This is the core mapping function. Takes a raw ATTOM property object and
// returns a parcel object matching the SellerSignal schema. Handles the
// value cascade (market → assessed → AVM), absentee derivation, and owner
// name extraction with graceful fallbacks.
//
// Returns null if the parcel is unusable (missing critical fields).

function transformProperty(attomProp, avmLookup = null) {
  const id = attomProp.identifier?.attomId;
  const addr = attomProp.address || {};
  const loc = attomProp.location || {};
  const summary = attomProp.summary || {};
  const assessment = attomProp.assessment || {};
  const building = attomProp.building || {};
  const lot = attomProp.lot || {};
  const area = attomProp.area || {};
  const owner = attomProp.owner || {};
  const sale = attomProp.sale || {};
  const vintage = attomProp.vintage || {};
  
  if (!id) return null;
  if (!addr.line1 || addr.line1.length < 3) return null;
  
  // VALUE CASCADE: market → assessed → AVM
  const market = assessment.market || {};
  const assessed = assessment.assessed || {};
  const avmFromLookup = avmLookup ? avmLookup.get(id) : null;
  
  let assessedValue = market.mktttlvalue || assessed.assdttlvalue || 0;
  let buildingValue = market.mktimprvalue || assessed.assdimprvalue || 0;
  let landValue = market.mktlandvalue || assessed.assdlandvalue || 0;
  let avmValue = 0;
  let avmConfidence = 0;
  
  if (avmFromLookup) {
    avmValue = avmFromLookup.value || 0;
    avmConfidence = avmFromLookup.scr || 0;
    if (assessedValue === 0) {
      assessedValue = avmValue;  // fall back to AVM when assessment is blank
    }
  }
  
  // Skip if no usable value at all
  if (assessedValue === 0 && avmValue === 0) return null;
  
  // OWNER NAME with fallback chain
  const owner1 = owner.owner1 || {};
  let ownerName = owner1.fullname || owner1.lastname || '';
  if (ownerName === 'NOT AVAILABLE FROM DATA SOURCE') ownerName = '';
  
  // ABSENTEE derivation from first-class ATTOM field
  const absenteeInd = summary.absenteeInd || '';
  const isAbsentee = absenteeInd !== 'OWNER OCCUPIED' && absenteeInd !== '';
  
  // OUT OF STATE derivation from mailing vs situs comparison
  const mailingAddr = owner.mailingAddress || {};
  const situsState = addr.countrySubd || '';
  const mailingState = mailingAddr.countrySubd || '';
  const isOutOfState = mailingState && situsState && mailingState !== situsState;
  
  // MARKET KEY from state + county (new convention for ATTOM-sourced data)
  const state = situsState;
  const county = area.countrysecsubd || '';
  const marketKey = county ? `ATTOM_${state}_${county.toUpperCase().replace(/\s+/g, '_')}` : `ATTOM_${state}`;
  
  return {
    id: `ATTOM-${addr.postal1}-${id}`,
    zip_code: addr.postal1,
    market_key: marketKey,
    
    // Owner fields
    owner_name: ownerName,
    owner_type: null,  // derived downstream by existing classifier
    
    // Address fields
    address: addr.line1,
    city: addr.locality || null,
    state: state,
    lat: parseFloat(loc.latitude) || null,
    lng: parseFloat(loc.longitude) || null,
    
    // Value fields (cascade applied)
    assessed_value: Math.round(assessedValue),
    building_value: Math.round(buildingValue),
    land_value: Math.round(landValue),
    
    // Property characteristics
    year_built: summary.yearbuilt || null,
    sqft: building.size?.livingsize || building.size?.universalsize || null,
    bedrooms: building.rooms?.beds || null,
    acres: lot.lotsize1 || (lot.lotsize2 ? lot.lotsize2 / 43560 : null),
    subdivision: area.subdname || null,
    prop_type: summary.propertyType || summary.proptype || null,
    is_vacant_land: summary.propIndicator === '80',
    
    // Ownership signals
    is_absentee: isAbsentee,
    is_out_of_state: !!isOutOfState,
    owner_state: mailingState || null,
    mailing_address: owner.mailingaddressoneline || null,
    mailing_city: mailingAddr.locality || null,
    mailing_state: mailingState || null,
    mailing_zip: mailingAddr.postal1 || null,
    multi_count: 1,  // computed post-ingest across the full batch
    
    // Transfer/tenure
    last_transfer_year: sale.salesearchdate ? parseInt(sale.salesearchdate.slice(0, 4), 10) : null,
    last_transfer_date: sale.salesearchdate || null,
    sale_price: sale.amount?.saleamt || null,
    tenure_years: null,  // computed downstream from last_transfer_year
    
    // NEW ATTOM-specific fields (require schema migration below)
    attom_id: id,
    match_code: addr.matchCode || null,
    prop_indicator: summary.propIndicator ? parseInt(summary.propIndicator, 10) : null,
    absentee_reason: absenteeInd || null,
    avm_value: avmValue || null,
    avm_confidence: avmConfidence || null,
    source_publication_date: vintage.lastModified || null,
    lender_name: attomProp.mortgage?.lender?.lastname || null,
    
    // Raw response for debugging
    raw_attributes: attomProp,
    
    // Timestamps
    fetched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ============================================================================
// COMPUTE MULTI-COUNT across the batch
// ============================================================================
// Count how many parcels each owner holds within this ZIP. Same logic as
// the existing worker.js multi_count calculation.

function computeMultiCount(parcels) {
  const counts = {};
  for (const p of parcels) {
    const key = (p.owner_name || '').toLowerCase().trim();
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  for (const p of parcels) {
    const key = (p.owner_name || '').toLowerCase().trim();
    p.multi_count = key ? (counts[key] || 1) : 1;
  }
}

// ============================================================================
// DATA QUALITY LOGGING
// ============================================================================
// Same pattern as the in-browser data quality check in sellersignal-briefing.html.
// Logs field coverage so we can see what ATTOM delivers vs. what's missing.

function logFieldCoverage(parcels) {
  if (parcels.length === 0) return;
  const total = parcels.length;
  const coverage = {
    owner_name: 0,
    assessed_value: 0,
    avm_value: 0,
    lat_lng: 0,
    year_built: 0,
    sqft: 0,
    absentee_classified: 0,
    last_transfer: 0,
    source_pub_date: 0,
    exact_match_code: 0,
  };
  
  for (const p of parcels) {
    if (p.owner_name && p.owner_name.length > 2) coverage.owner_name += 1;
    if (p.assessed_value > 0) coverage.assessed_value += 1;
    if (p.avm_value && p.avm_value > 0) coverage.avm_value += 1;
    if (p.lat && p.lng) coverage.lat_lng += 1;
    if (p.year_built) coverage.year_built += 1;
    if (p.sqft) coverage.sqft += 1;
    if (p.absentee_reason) coverage.absentee_classified += 1;
    if (p.last_transfer_date) coverage.last_transfer += 1;
    if (p.source_publication_date) coverage.source_pub_date += 1;
    if (p.match_code === 'ExaStr') coverage.exact_match_code += 1;
  }
  
  console.log('\n  Field coverage across ingested parcels:');
  for (const [field, count] of Object.entries(coverage)) {
    const pct = ((count / total) * 100).toFixed(1);
    console.log(`    ${field.padEnd(24)} ${String(count).padStart(5)} / ${total}  (${pct}%)`);
  }
}

// ============================================================================
// MAIN INGEST FUNCTION
// ============================================================================

async function ingestZip(zip, opts = {}) {
  const { limit = 0, dryRun = false } = opts;
  const t0 = Date.now();
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`ATTOM INGEST: ${zip}${dryRun ? ' [DRY RUN]' : ''}${limit ? ` [limit ${limit}]` : ''}`);
  console.log('='.repeat(70));
  
  // Step 1: Fetch property data
  console.log('\nStep 1: Fetching /property/detailmortgageowner...');
  const properties = await paginate(
    '/property/detailmortgageowner',
    { postalCode: zip },
    (page, count, total) => console.log(`  page ${page}: ${count} properties (total ${total})`),
    limit
  );
  console.log(`  Fetched ${properties.length} raw property records`);
  
  if (properties.length === 0) {
    console.log('  No properties returned. Stopping.');
    return { zip, parcels: [], fetched: 0, transformed: 0, written: 0 };
  }
  
  // Step 2: Detect state and decide if AVM fallback needed
  const firstState = properties[0]?.address?.countrySubd || '';
  const needsAvm = ASSESSOR_SPARSE_STATES.has(firstState);
  console.log(`  State detected: ${firstState}${needsAvm ? ' (assessor-sparse, AVM fallback required)' : ''}`);
  
  // Step 3: Fetch AVM data if needed
  let avmLookup = null;
  if (needsAvm) {
    console.log('\nStep 2: Fetching /attomavm/detail for value cascade...');
    const avmProps = await paginate(
      '/attomavm/detail',
      { postalCode: zip },
      (page, count, total) => console.log(`  page ${page}: ${count} AVMs (total ${total})`),
      limit
    );
    console.log(`  Fetched ${avmProps.length} AVM records`);
    
    // Build lookup by attomId
    avmLookup = new Map();
    for (const ap of avmProps) {
      const aid = ap.identifier?.attomId;
      const amount = ap.avm?.amount;
      if (aid && amount) avmLookup.set(aid, amount);
    }
    console.log(`  Indexed ${avmLookup.size} AVMs for lookup`);
  }
  
  // Step 4: Transform
  console.log('\nStep 3: Transforming to SellerSignal schema...');
  const parcels = [];
  let skippedNoId = 0;
  let skippedNoAddress = 0;
  let skippedNoValue = 0;
  
  for (const prop of properties) {
    const parcel = transformProperty(prop, avmLookup);
    if (!parcel) {
      if (!prop.identifier?.attomId) skippedNoId += 1;
      else if (!prop.address?.line1) skippedNoAddress += 1;
      else skippedNoValue += 1;
      continue;
    }
    parcels.push(parcel);
  }
  
  console.log(`  Transformed ${parcels.length} parcels`);
  console.log(`  Skipped: ${skippedNoId} no_id, ${skippedNoAddress} no_address, ${skippedNoValue} no_value`);
  
  computeMultiCount(parcels);
  logFieldCoverage(parcels);
  
  // Step 5: Write to shadow table
  let written = 0;
  if (!dryRun) {
    console.log('\nStep 4: Writing to attom_parcels shadow table...');
    if (!supabase) {
      console.error('  ERROR: Supabase client not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
    } else {
      const BATCH_SIZE = 500;
      for (let i = 0; i < parcels.length; i += BATCH_SIZE) {
        const batch = parcels.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from('attom_parcels').upsert(batch, { onConflict: 'id' });
        if (error) {
          console.error(`  Batch ${i}-${i + batch.length} failed: ${error.message}`);
        } else {
          written += batch.length;
          console.log(`  Upserted ${written} / ${parcels.length}`);
        }
      }
    }
  } else {
    console.log('\nStep 4: [DRY RUN] Skipping database writes.');
    if (parcels.length > 0) {
      console.log('\n  Sample transformed parcel (first record):');
      const sample = { ...parcels[0] };
      delete sample.raw_attributes;  // too noisy for console
      console.log(JSON.stringify(sample, null, 2).split('\n').map(l => '    ' + l).join('\n'));
    }
  }
  
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`DONE: ${zip} — fetched ${properties.length}, transformed ${parcels.length}, written ${written} in ${elapsed}s`);
  console.log('='.repeat(70));
  
  return { zip, parcels, fetched: properties.length, transformed: parcels.length, written };
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main() {
  const { zip, limit, dryRun } = parseArgs();
  
  if (!ATTOM_KEY) {
    console.error('ERROR: ATTOM_API_KEY environment variable not set');
    console.error('Add to .env: ATTOM_API_KEY=your_key_here');
    process.exit(1);
  }
  
  try {
    await ingestZip(zip, { limit, dryRun });
    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { ingestZip, transformProperty, ASSESSOR_SPARSE_STATES, OWNER_REDACTED_STATES };

// ============================================================================
// SCHEMA MIGRATION
// ============================================================================
// Run this in Supabase SQL editor BEFORE the first ingest run.
// Creates a shadow table that mirrors the production parcels table
// structure but with ATTOM-specific fields added.
//
// -- ============================================================================
// -- ATTOM SHADOW PARCELS TABLE
// -- ============================================================================
// CREATE TABLE IF NOT EXISTS attom_parcels (
//   id TEXT PRIMARY KEY,                    -- "ATTOM-{zip}-{attom_id}"
//   zip_code TEXT NOT NULL,
//   market_key TEXT NOT NULL,               -- "ATTOM_{STATE}_{COUNTY}"
//
//   -- Owner info
//   owner_name TEXT,
//   owner_type TEXT,
//
//   -- Property info
//   address TEXT,
//   city TEXT,
//   state TEXT,
//   lat DOUBLE PRECISION,
//   lng DOUBLE PRECISION,
//   assessed_value INTEGER,
//   building_value INTEGER,
//   land_value INTEGER,
//   year_built INTEGER,
//   sqft INTEGER,
//   bedrooms INTEGER,
//   acres DOUBLE PRECISION,
//   subdivision TEXT,
//   prop_type TEXT,
//   is_vacant_land BOOLEAN DEFAULT FALSE,
//
//   -- Ownership signals
//   is_absentee BOOLEAN DEFAULT FALSE,
//   is_out_of_state BOOLEAN DEFAULT FALSE,
//   owner_state TEXT,
//   mailing_address TEXT,
//   mailing_city TEXT,
//   mailing_state TEXT,
//   mailing_zip TEXT,
//   multi_count INTEGER DEFAULT 1,
//
//   -- Transfer/tenure
//   last_transfer_year INTEGER,
//   last_transfer_date TEXT,
//   sale_price INTEGER,
//   tenure_years DOUBLE PRECISION,
//
//   -- NEW ATTOM-specific fields
//   attom_id BIGINT,                        -- ATTOM's stable parcel ID
//   match_code TEXT,                        -- "ExaStr" etc.
//   prop_indicator SMALLINT,                -- 10=SFR, 11=Condo, 22=Apt
//   absentee_reason TEXT,                   -- raw absenteeInd string
//   avm_value INTEGER,                      -- ATTOM AVM value
//   avm_confidence SMALLINT,                -- AVM confidence 0-100
//   source_publication_date DATE,           -- ATTOM vintage.lastModified
//   lender_name TEXT,                       -- mortgage lender
//
//   -- Raw response for debugging
//   raw_attributes JSONB,
//
//   -- Timestamps
//   fetched_at TIMESTAMPTZ DEFAULT NOW(),
//   updated_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// CREATE INDEX IF NOT EXISTS idx_attom_parcels_zip ON attom_parcels(zip_code);
// CREATE INDEX IF NOT EXISTS idx_attom_parcels_market ON attom_parcels(market_key);
// CREATE INDEX IF NOT EXISTS idx_attom_parcels_attom_id ON attom_parcels(attom_id);
// CREATE INDEX IF NOT EXISTS idx_attom_parcels_fetched_at ON attom_parcels(fetched_at);
