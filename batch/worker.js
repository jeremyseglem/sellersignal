#!/usr/bin/env node
// SellerSignal Batch Worker
// Runs nightly (or on-demand) to fetch, score, and store all parcel data
// Usage: node batch/worker.js [--zip 33134] [--market FL_MD] [--all] [--dry-run]

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { MARKETS, getAllZips, getMarketForZip } = require('./markets');

// =============================================
// CLIENTS
// =============================================
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// =============================================
// CONFIG
// =============================================
const CONFIG = {
  liteScoreBatchSize: 500,     // how many parcels get AI Lite scoring per ZIP
  deepSignalCount: 15,          // top N get full Deep Signal per ZIP
  fetchDelayMs: 1500,           // delay between GIS requests (be polite)
  liteDelayMs: 200,             // delay between Lite API calls
  dryRun: false,                // log but don't write to DB
};

// =============================================
// CLI ARGS
// =============================================
const args = process.argv.slice(2);
let targetZip = null, targetMarket = null, runAll = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--zip' && args[i+1]) targetZip = args[++i];
  if (args[i] === '--market' && args[i+1]) targetMarket = args[++i];
  if (args[i] === '--all') runAll = true;
  if (args[i] === '--dry-run') CONFIG.dryRun = true;
}
if (!supabase) { CONFIG.dryRun = true; log('No Supabase connection — forcing dry-run mode', 'warn'); }

// =============================================
// LOGGING
// =============================================
function log(msg, level = 'info') {
  const ts = new Date().toISOString().substring(11, 19);
  const prefix = { info: '  ', warn: '⚠ ', error: '✗ ', ok: '✓ ' }[level] || '  ';
  console.log(`[${ts}] ${prefix}${msg}`);
}

// =============================================
// GIS FETCHER — pulls parcels from ArcGIS REST endpoints
// =============================================
async function fetchParcels(market, zip) {
  const url = new URL(market.url);
  
  // Build WHERE clause — different markets use different ZIP field patterns
  let where;
  if (market.key === 'FL_MD') where = `TRUE_SITE_ZIP_CODE LIKE '${zip}%'`;
  else if (market.key === 'FL_PB') where = `ZIP1='${zip}'`;
  else if (market.key === 'NC') where = `szip='${zip}'`;
  else if (market.key === 'MT') where = `1=1`; // Montana uses spatial query, not ZIP
  else if (market.key === 'WA_KING') where = `ZIPCODE='${zip}'`;
  else if (market.key === 'OR_DESCHUTES') where = `SitusZip='${zip}'`;
  else if (market.key === 'AZ_MARICOPA') where = `ZIP_CODE='${zip}'`;
  else if (market.key === 'TX_SA') where = `situs_zip='${zip}'`;
  else if (market.key === 'NY') where = `1=1`; // NY uses spatial, complex
  else where = `1=1`;
  
  const params = new URLSearchParams({
    where,
    outFields: market.fields,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
    resultRecordCount: String(market.max || 2000),
  });
  
  const fullUrl = `${market.url}?${params}`;
  log(`Fetching ${zip} from ${market.name}...`);
  
  let resp;
  try {
    resp = await fetch(fullUrl, { signal: AbortSignal.timeout(30000) });
  } catch(fetchErr) {
    throw new Error(`GIS fetch failed for ${zip}: ${fetchErr.message}`);
  }
  if (!resp.ok) throw new Error(`GIS HTTP ${resp.status} for ${zip}`);
  
  const data = await resp.json();
  if (data.error) throw new Error(`GIS error: ${data.error.message}`);
  
  const features = data.features || [];
  log(`Got ${features.length} parcels for ${zip}`, 'ok');
  return features;
}

// =============================================
// PARCEL PARSER — converts GIS features to normalized parcel objects
// =============================================
function parseParcel(feature, market) {
  const a = feature.attributes || {};
  const fm = market.fieldMap;
  
  // Helper to get value from field name or array of field names
  function getVal(fieldDef) {
    if (!fieldDef) return null;
    if (Array.isArray(fieldDef)) {
      for (const f of fieldDef) {
        const v = a[f];
        if (v !== null && v !== undefined && v !== '' && v !== 0) return v;
      }
      return a[fieldDef[0]] || null;
    }
    return a[fieldDef] ?? null;
  }
  
  function getStr(fieldDef) {
    const v = getVal(fieldDef);
    return v ? String(v).trim() : '';
  }
  
  function getNum(fieldDef) {
    const v = getVal(fieldDef);
    return v ? parseFloat(v) || 0 : 0;
  }
  
  // Owner name — may be array of fields to concatenate
  let ownerName = '';
  if (Array.isArray(fm.ownerName)) {
    ownerName = fm.ownerName.map(f => (a[f] || '').toString().trim()).filter(Boolean).join(' ');
  } else {
    ownerName = getStr(fm.ownerName);
  }
  
  // Owner type classification
  const on = ownerName.toUpperCase();
  let ownerType = 'individual';
  if (/\bTRUST\b|\bTRSTEE?\b|\bTRUSTEE\b/.test(on)) ownerType = 'trust';
  else if (/\bESTATE\b|\bHEIRS?\b|\bDECEASED\b/.test(on)) ownerType = 'estate';
  else if (/\bLLC\b|\bCORP\b|\bINC\b|\bLTD\b|\bLP\b|\bPARTNERSHIP\b|\bHOLDINGS?\b|\bGROUP\b|\bPROPERTIES\b|\bINVESTMENTS?\b|\bMANAGEMENT\b|\bREALTY\b/.test(on)) ownerType = 'llc_corp';
  
  // Values
  const totalValue = getNum(fm.totalValue) || (getNum(fm.landValue) + getNum(fm.buildingValue));
  const buildingValue = getNum(fm.buildingValue);
  const landValue = getNum(fm.landValue);
  const yearBuilt = parseInt(getVal(fm.yearBuilt)) || 0;
  const sqft = parseInt(getVal(fm.livingSpace)) || 0;
  
  // Address
  const address = getStr(fm.address);
  const city = getStr(fm.situsCity);
  
  // Mailing
  const mailAddr = getStr(fm.mailAddress);
  const mailCity = getStr(fm.mailCity);
  const mailState = getStr(fm.mailState);
  const mailZip = getStr(fm.mailZip);
  
  // Absentee detection
  const situsNorm = address.toLowerCase().replace(/\s+/g, '');
  const mailNorm = mailAddr.toLowerCase().replace(/\s+/g, '');
  const isAbsentee = mailAddr && address && situsNorm.length > 5 && !mailNorm.includes(situsNorm.substring(0, Math.min(10, situsNorm.length)));
  const isOutOfState = mailState && mailState.toUpperCase() !== market.homeState;
  
  // Vacant land detection
  const hasBuilding = buildingValue > 0 || yearBuilt > 1800 || sqft > 0;
  const isVacantLand = !hasBuilding && totalValue > 0;
  
  // Tenure
  let lastTransferYear = null, lastTransferDate = null, salePrice = 0;
  const rawSaleDate = getVal(fm.saleDate);
  if (rawSaleDate) {
    const sd = String(rawSaleDate);
    // Try YYYYMMDD format (Florida)
    if (/^\d{8}$/.test(sd)) {
      lastTransferYear = parseInt(sd.substring(0, 4));
      lastTransferDate = `${sd.substring(0,4)}-${sd.substring(4,6)}-${sd.substring(6,8)}`;
    }
    // Try epoch ms
    else if (/^\d{10,13}$/.test(sd)) {
      const d = new Date(parseInt(sd.length > 10 ? sd : sd + '000'));
      if (d.getFullYear() > 1900) { lastTransferYear = d.getFullYear(); lastTransferDate = d.toISOString().substring(0,10); }
    }
    // Try ISO or date string
    else {
      const d = new Date(sd);
      if (!isNaN(d) && d.getFullYear() > 1900) { lastTransferYear = d.getFullYear(); lastTransferDate = d.toISOString().substring(0,10); }
    }
  }
  salePrice = getNum(fm.salePrice);
  
  const currentYear = new Date().getFullYear();
  const tenureYears = lastTransferYear ? currentYear - lastTransferYear : null;
  
  // Lat/Lng
  let lat = 0, lng = 0;
  if (feature.geometry) {
    if (feature.geometry.x) { lng = feature.geometry.x; lat = feature.geometry.y; }
    else if (feature.geometry.rings) {
      const ring = feature.geometry.rings[0];
      if (ring && ring.length > 0) {
        lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
        lng = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      }
    }
  }
  
  // Acres
  let acres = getNum(fm.acres);
  if (market.acresIsSqft && acres > 0) acres = Math.round(acres / 43560 * 100) / 100;
  
  return {
    id: `${market.key}-${getStr(fm.id) || address.replace(/\s/g,'')}`,
    zip_code: null, // set by caller
    market_key: market.key,
    owner_name: ownerName,
    owner_type: ownerType,
    address, city, state: market.homeState,
    lat, lng,
    assessed_value: Math.round(totalValue),
    building_value: Math.round(buildingValue),
    land_value: Math.round(landValue),
    year_built: yearBuilt || null,
    sqft: sqft || null,
    bedrooms: parseInt(getVal('BEDROOM_COUNT')) || null,
    acres: acres || null,
    subdivision: getStr(fm.subdivision),
    prop_type: isVacantLand ? 'Vacant Land' : 'Residential',
    is_vacant_land: isVacantLand,
    is_absentee: !!isAbsentee,
    is_out_of_state: !!isOutOfState,
    owner_state: mailState || null,
    mailing_address: mailAddr || null,
    mailing_city: mailCity || null,
    mailing_state: mailState || null,
    mailing_zip: mailZip || null,
    multi_count: 1, // computed in batch
    last_transfer_year: lastTransferYear,
    last_transfer_date: lastTransferDate,
    sale_price: salePrice || null,
    tenure_years: tenureYears,
    raw_attributes: a,
  };
}

// =============================================
// HEURISTIC SCORER — scores every parcel (fast, no API calls)
// =============================================
function scoreParcel(p, calibration) {
  let sl = 20, omr = 20, act = 25, conf = 30;
  const signals = [];
  
  // Filter junk
  const on = (p.owner_name || '').toUpperCase();
  const govRx = /\bCITY OF\b|\bCOUNTY OF\b|\bSTATE OF\b|\bUNITED STATES\b|\bFEDERAL\b|\bSCHOOL DIST|\bCHURCH\b|\bHOA\b|\bCOMMON\s*AREA|\bCONDO\s*ASSOC/i;
  if (govRx.test(on)) return null; // skip institutional
  
  function cal(defaultBonus, featureKey) {
    if (!calibration || !calibration.lifts || !(featureKey in calibration.lifts)) return defaultBonus;
    const lift = calibration.lifts[featureKey];
    if (lift >= 1) return Math.round(defaultBonus * Math.min(lift, 3));
    return Math.round(-defaultBonus * (1 - lift));
  }
  
  // Entity signals
  const isTrust = p.owner_type === 'trust';
  const isEstate = p.owner_type === 'estate';
  const isLLC = p.owner_type === 'llc_corp';
  const isIndividual = p.owner_type === 'individual';
  
  if (isEstate) sl += cal(20, 'Estates / Heirs');
  if (isTrust && p.is_absentee) sl += cal(16, 'Trusts');
  else if (isTrust) sl += cal(8, 'Trusts');
  
  if (p.is_absentee && p.is_out_of_state) sl += cal(14, 'Out-of-State');
  else if (p.is_out_of_state) sl += cal(8, 'Out-of-State');
  else if (p.is_absentee) sl += cal(6, 'Absentee Owners');
  
  if (p.is_vacant_land && p.is_absentee) sl += cal(12, 'Vacant Land');
  else if (p.is_vacant_land) sl += cal(6, 'Vacant Land');
  
  if (isIndividual && p.mailing_address) sl += cal(4, 'Named Individuals');
  
  // Tenure
  if (p.tenure_years !== null) {
    if (p.tenure_years <= 1) sl -= 15;
    else if (p.tenure_years <= 2) sl -= 10;
    else if (p.tenure_years <= 3) sl -= 5;
    else if (p.tenure_years <= 10) sl += cal(10, 'Tenure 3-10yr');
    else if (p.tenure_years <= 20) sl += cal(8, 'Tenure 10-20yr');
    else sl += cal(6, 'Tenure 20yr+');
  }
  
  // LLC penalty
  if (isLLC && !p.is_absentee && !p.is_out_of_state) sl -= 5;
  
  // Vacant land dampener
  if (p.is_vacant_land && !p.tenure_years) sl -= 6;
  
  sl = Math.max(0, Math.min(100, sl));
  
  // Off-market receptivity
  if (isTrust || isEstate) omr += 12;
  if (isLLC) omr += 10;
  if (p.is_absentee) omr += 10;
  if (p.is_out_of_state) omr += 8;
  if (p.assessed_value > 750000) omr += 10;
  if (p.is_vacant_land) omr += 6;
  omr = Math.max(0, Math.min(100, omr));
  
  // Actionability
  const hasName = on.length > 3;
  const hasMail = (p.mailing_address || '').length > 5;
  if (hasName && hasMail) act += 15;
  else if (hasName) act += 8;
  if (isIndividual && hasName) act += 12;
  if (isTrust && hasMail) act += 8;
  if (isLLC && !hasMail) act -= 15;
  act = Math.max(0, Math.min(100, act));
  
  // Confidence
  if (hasName) conf += 10;
  if (hasMail) conf += 8;
  if (p.assessed_value > 0) conf += 6;
  if (p.tenure_years !== null) conf += 10;
  conf = Math.max(0, Math.min(100, conf));
  
  const briefingRank = Math.round(sl * 0.50 + act * 0.30 + omr * 0.15 + conf * 0.05);
  const scoreClass = briefingRank >= 55 ? 'high' : briefingRank >= 35 ? 'medium' : 'low';
  
  let cohort = 'residential';
  if (isEstate) cohort = 'estate';
  else if (isTrust) cohort = 'trust';
  else if (isLLC) cohort = 'investor';
  else if (p.is_absentee || p.is_out_of_state) cohort = 'absentee';
  else if (p.is_vacant_land) cohort = 'vacant';
  
  return {
    seller_likelihood: sl, off_market_receptivity: omr,
    actionability: act, confidence: conf,
    briefing_rank: briefingRank, score_class: scoreClass,
    cohort, signals,
  };
}

// =============================================
// BACKTEST + CALIBRATION — compute conversion rates from historical sales
// =============================================
function computeCalibration(parcels, scores) {
  const now = new Date();
  const cutoff24 = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
  
  const scored = parcels.map((p, i) => ({ ...p, ...scores[i] })).filter(s => s);
  const sold24 = scored.filter(p => {
    if (!p.last_transfer_date) return false;
    const d = new Date(p.last_transfer_date);
    return d >= cutoff24 && d < now && (p.sale_price > 10000 || !p.sale_price);
  });
  
  if (sold24.length < 10) return null; // insufficient data
  
  const baseRate = sold24.length / scored.length;
  
  function featureRate(filterFn) {
    const pool = scored.filter(filterFn);
    const soldInPool = sold24.filter(filterFn);
    return pool.length > 0 ? soldInPool.length / pool.length : 0;
  }
  
  const rates = {
    'All Properties': baseRate,
    'Trusts': featureRate(p => p.owner_type === 'trust'),
    'Estates / Heirs': featureRate(p => p.owner_type === 'estate'),
    'LLCs / Corps': featureRate(p => p.owner_type === 'llc_corp'),
    'Absentee Owners': featureRate(p => p.is_absentee),
    'Out-of-State': featureRate(p => p.is_out_of_state),
    'Vacant Land': featureRate(p => p.is_vacant_land),
    'Named Individuals': featureRate(p => p.owner_type === 'individual'),
  };
  
  // Tenure buckets
  const withTenure = scored.filter(p => p.tenure_years !== null);
  if (withTenure.length > scored.length * 0.3) {
    rates['Tenure 0-3yr'] = featureRate(p => p.tenure_years !== null && p.tenure_years <= 3);
    rates['Tenure 3-10yr'] = featureRate(p => p.tenure_years !== null && p.tenure_years > 3 && p.tenure_years <= 10);
    rates['Tenure 10-20yr'] = featureRate(p => p.tenure_years !== null && p.tenure_years > 10 && p.tenure_years <= 20);
    rates['Tenure 20yr+'] = featureRate(p => p.tenure_years !== null && p.tenure_years > 20);
  }
  
  // Compute lifts
  const lifts = {};
  for (const [key, rate] of Object.entries(rates)) {
    if (key !== 'All Properties' && baseRate > 0) {
      lifts[key] = rate / baseRate;
    }
  }
  
  const avgScoreSold = sold24.reduce((s, p) => s + (p.briefing_rank || 0), 0) / sold24.length;
  const avgScoreNotSold = scored.filter(p => !sold24.includes(p)).reduce((s, p) => s + (p.briefing_rank || 0), 0) / (scored.length - sold24.length);
  
  return {
    baseRate, lifts, rates,
    sold24: sold24.length, total: scored.length,
    avgScoreSold: Math.round(avgScoreSold),
    avgScoreNotSold: Math.round(avgScoreNotSold),
    scoreGap: Math.round(avgScoreSold - avgScoreNotSold),
  };
}

// =============================================
// MAIN: Process a single ZIP code
// =============================================
async function processZip(zip, market) {
  const startTime = Date.now();
  log(`\n${'='.repeat(50)}`);
  log(`Processing ${zip} — ${market.name}`);
  log(`${'='.repeat(50)}`);
  
  // 1. FETCH parcels
  const features = await fetchParcels(market, zip);
  if (features.length === 0) { log(`No parcels found for ${zip}`, 'warn'); return; }
  
  // 2. PARSE parcels
  const parcels = features.map(f => {
    const p = parseParcel(f, market);
    p.zip_code = zip;
    return p;
  }).filter(p => p.address && p.owner_name);
  
  log(`Parsed ${parcels.length} valid parcels (${features.length - parcels.length} filtered)`);
  
  // 3. Compute multi-property counts
  const ownerCounts = {};
  for (const p of parcels) {
    const key = p.owner_name.toUpperCase().trim();
    ownerCounts[key] = (ownerCounts[key] || 0) + 1;
  }
  for (const p of parcels) {
    p.multi_count = ownerCounts[p.owner_name.toUpperCase().trim()] || 1;
  }
  
  // 4. FIRST PASS: Score with generic weights
  let scores = parcels.map(p => scoreParcel(p, null)).filter(Boolean);
  log(`Scored ${scores.length} parcels (generic weights)`);
  
  // 5. BACKTEST: Compute calibration from historical data
  const calibration = computeCalibration(parcels, scores);
  if (calibration) {
    log(`Calibration: base=${(calibration.baseRate*100).toFixed(1)}%, sold=${calibration.sold24}, gap=${calibration.scoreGap > 0 ? '+' : ''}${calibration.scoreGap}`, 'ok');
    
    // 6. SECOND PASS: Re-score with calibrated weights
    scores = parcels.map(p => scoreParcel(p, calibration)).filter(Boolean);
    
    const cal2 = computeCalibration(parcels, scores);
    if (cal2) {
      log(`After calibration: gap=${cal2.scoreGap > 0 ? '+' : ''}${cal2.scoreGap} (was ${calibration.scoreGap > 0 ? '+' : ''}${calibration.scoreGap})`, 'ok');
    }
  } else {
    log(`No calibration data (< 10 sales in 24mo)`, 'warn');
  }
  
  // 7. RANK and pick candidates for AI scoring
  const ranked = parcels.map((p, i) => ({ parcel: p, score: scores[i] }))
    .filter(x => x.score)
    .sort((a, b) => b.score.briefing_rank - a.score.briefing_rank);
  
  const topForLite = ranked.slice(0, CONFIG.liteScoreBatchSize);
  log(`Top ${topForLite.length} candidates selected for AI Lite scoring`);
  
  // 8. STORE parcels + scores in Supabase
  if (!CONFIG.dryRun) {
    log(`Writing ${parcels.length} parcels to Supabase...`);
    
    // Upsert parcels in batches of 500
    for (let i = 0; i < parcels.length; i += 500) {
      const batch = parcels.slice(i, i + 500).map(p => ({
        ...p,
        raw_attributes: undefined, // don't store raw for now (save space)
        fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
      
      const { error } = await supabase.from('parcels').upsert(batch, { onConflict: 'id' });
      if (error) log(`Parcel upsert error: ${error.message}`, 'error');
    }
    
    // Upsert scores
    const scoreRows = ranked.map(r => ({
      parcel_id: r.parcel.id,
      zip_code: zip,
      market_key: market.key,
      ...r.score,
      calibrated_rank: r.score.briefing_rank, // same for now, until AI re-scores
      scored_at: new Date().toISOString(),
    }));
    
    for (let i = 0; i < scoreRows.length; i += 500) {
      const batch = scoreRows.slice(i, i + 500);
      const { error } = await supabase.from('parcel_scores').upsert(batch, { onConflict: 'parcel_id' });
      if (error) log(`Score upsert error: ${error.message}`, 'error');
    }
    
    // Store briefing summary
    const { error: briefErr } = await supabase.from('zip_briefings').upsert({
      zip_code: zip,
      market_key: market.key,
      market_name: market.name,
      total_parcels: parcels.length,
      unique_owners: new Set(parcels.map(p => p.owner_name.toUpperCase())).size,
      act_today_count: ranked.filter(r => r.score.briefing_rank >= 55).length,
      outreach_queue_count: ranked.filter(r => r.score.briefing_rank >= 35).length,
      act_today_ids: ranked.filter(r => r.score.briefing_rank >= 55).slice(0, 15).map(r => r.parcel.id),
      outreach_queue_ids: ranked.filter(r => r.score.briefing_rank >= 35).slice(0, 50).map(r => r.parcel.id),
      calibration: calibration || null,
      computed_at: new Date().toISOString(),
      computation_time_ms: Date.now() - startTime,
    }, { onConflict: 'zip_code' });
    
    if (briefErr) log(`Briefing upsert error: ${briefErr.message}`, 'error');
    
    log(`Stored in Supabase`, 'ok');
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Completed ${zip} in ${elapsed}s — ${parcels.length} parcels, top score: ${ranked[0]?.score.briefing_rank || 0}`);
  
  return { zip, parcels: parcels.length, elapsed, calibration };
}

// =============================================
// MAIN: Run the batch
// =============================================
async function main() {
  log('SellerSignal Batch Worker starting...');
  log(`Config: liteSize=${CONFIG.liteScoreBatchSize}, deepSignals=${CONFIG.deepSignalCount}, dryRun=${CONFIG.dryRun}`);
  
  // Determine which ZIPs to process
  let zipsToProcess = [];
  
  if (targetZip) {
    const market = getMarketForZip(targetZip);
    if (!market) { log(`Unknown ZIP: ${targetZip}`, 'error'); process.exit(1); }
    zipsToProcess = [{ zip: targetZip, market }];
  } else if (targetMarket) {
    const market = MARKETS[targetMarket];
    if (!market) { log(`Unknown market: ${targetMarket}`, 'error'); process.exit(1); }
    zipsToProcess = market.zips.map(zip => ({ zip, market }));
  } else if (runAll) {
    zipsToProcess = getAllZips().map(z => ({ zip: z.zip, market: MARKETS[z.marketKey] }));
  } else {
    log('Usage: node batch/worker.js [--zip 33134] [--market FL_MD] [--all] [--dry-run]');
    log(`Available markets: ${Object.keys(MARKETS).join(', ')}`);
    log(`Total ZIPs: ${getAllZips().length}`);
    process.exit(0);
  }
  
  log(`Processing ${zipsToProcess.length} ZIP codes across ${new Set(zipsToProcess.map(z => z.market.key)).size} markets\n`);
  
  // Create batch run record
  let batchRunId = null;
  if (!CONFIG.dryRun) {
    const { data } = await supabase.from('batch_runs').insert({
      started_at: new Date().toISOString(),
      status: 'running',
    }).select('id').single();
    batchRunId = data?.id;
  }
  
  const results = [];
  const errors = [];
  
  for (const { zip, market } of zipsToProcess) {
    try {
      const result = await processZip(zip, market);
      results.push(result);
      
      // Be polite to GIS servers
      await new Promise(r => setTimeout(r, CONFIG.fetchDelayMs));
    } catch (err) {
      log(`FAILED: ${zip} — ${err.message}`, 'error');
      errors.push({ zip, error: err.message });
    }
  }
  
  // Update batch run
  if (!CONFIG.dryRun && batchRunId) {
    await supabase.from('batch_runs').update({
      completed_at: new Date().toISOString(),
      status: errors.length > 0 ? 'completed_with_errors' : 'completed',
      zips_processed: results.length,
      parcels_processed: results.reduce((s, r) => s + (r?.parcels || 0), 0),
      errors: errors.length > 0 ? errors : null,
    }).eq('id', batchRunId);
  }
  
  // Summary
  log(`\n${'='.repeat(50)}`);
  log(`BATCH COMPLETE`);
  log(`${'='.repeat(50)}`);
  log(`ZIPs processed: ${results.length}/${zipsToProcess.length}`);
  log(`Total parcels: ${results.reduce((s, r) => s + (r?.parcels || 0), 0).toLocaleString()}`);
  if (errors.length) log(`Errors: ${errors.length}`, 'error');
}

main().catch(err => {
  log(`Fatal error: ${err.message}`, 'error');
  console.error(err);
  process.exit(1);
});
