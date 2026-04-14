#!/usr/bin/env node
// SellerSignal Batch Worker — uses EXACT same pipeline as briefing HTML
// Usage: node batch/worker.js [--zip 33134] [--market FL_MD] [--all] [--noai]

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { MARKETS, getAllZips, getMarketForZip } = require('./markets');
const { precomputeStats, scoreParcel, enrichTenure } = require('./pipeline');

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const args = process.argv.slice(2);
let targetZip = null, targetMarket = null, runAll = false, skipAI = false;
for (let i = 0; i < args.length; i++) {
  if (args[i]==='--zip'&&args[i+1]) targetZip=args[++i];
  if (args[i]==='--market'&&args[i+1]) targetMarket=args[++i];
  if (args[i]==='--all') runAll=true;
  if (args[i]==='--noai') skipAI=true;
}
if (!targetZip && !targetMarket && !runAll) runAll = true;

function log(msg) { console.log(`[${new Date().toISOString().substring(11,19)}] ${msg}`); }

async function processZip(zip, market) {
  const t0 = Date.now();
  log(`=== ${zip} — ${market.name} ===`);
  if (!market.zipWhere) { log('  SKIP: needs spatial query'); return null; }

  // === LAYER METADATA FETCH (best-effort, for source freshness badge) ===
  // ArcGIS layer metadata endpoint exposes editingInfo.lastEditDate when the
  // host enables it. We probe once per ZIP run, stamp every parcel with the
  // result, and fail silently if the host doesn't expose it. Adds one HTTP
  // call per ZIP per nightly run — negligible cost. Markets known to expose
  // this as of April 8 2026: WA_KING (King County), NY (NYS Tax Parcels),
  // FL_MD (Miami-Dade). Other markets fall back to fetched_at downstream.
  let sourceModifiedDate = null;
  try {
    const metaUrl = market.url.replace(/\/query$/, '') + '?f=json';
    const metaResp = await fetch(metaUrl, { signal: AbortSignal.timeout(15000) });
    if (metaResp.ok) {
      const meta = await metaResp.json();
      const lastEdit = meta?.editingInfo?.lastEditDate;
      if (lastEdit && typeof lastEdit === 'number') {
        const d = new Date(lastEdit);
        if (d.getFullYear() > 2000) {
          sourceModifiedDate = d.toISOString().split('T')[0];
          log(`  source last edited: ${sourceModifiedDate}`);
        }
      }
    }
  } catch (e) { /* metadata fetch is best-effort, never blocks ingest */ }

  // === PAGINATED FETCH ===
  let allFeatures = [], offset = 0, keepFetching = true;
  log('  Fetching...');
  while (keepFetching) {
    const params = new URLSearchParams({
      where: market.zipWhere(zip), outFields: market.fields,
      returnGeometry: market.noGeometry ? 'false' : 'true',
      outSR: '4326', f: 'json', resultRecordCount: '2000', resultOffset: String(offset),
    });
    const resp = await fetch(`${market.url}?${params}`, { signal: AbortSignal.timeout(90000) });
    const data = await resp.json();
    const features = data.features || [];
    allFeatures = allFeatures.concat(features);
    const capped = data.exceededTransferLimit === true || (features.length >= 1000 && features.length % 1000 === 0);
    if (features.length === 0 || (!capped && features.length < 2000)) keepFetching = false;
    else { offset += features.length; log(`  ... ${allFeatures.length}`); await new Promise(r => setTimeout(r, 500)); }
    if (allFeatures.length >= 20000) keepFetching = false;
  }
  log(`  ${allFeatures.length} features`);
  if (!allFeatures.length) return null;

  // === PARSE using market's own parse function (same as briefing HTML) ===
  let parcels = [];
  for (const f of allFeatures) {
    try {
      const p = market.parse(f);
      if (!p) continue;
      // Keep all parcels that have an address — same as briefing HTML
      // scoreParcel handles blank names (scores them lower, doesn't exclude them)
      if (p.address && p.address.length >= 3) {
        // Stamp source freshness from the layer metadata fetch above. Only set
        // if parseParcel didn't already populate it from a per-record field.
        if (sourceModifiedDate && !p.sourceModifiedDate) p.sourceModifiedDate = sourceModifiedDate;
        parcels.push(p);
      }
    } catch(e) { /* skip unparseable */ }
  }
  log(`  ${parcels.length} parsed`);

  // === TENURE ENRICHMENT (King County sales endpoint) ===
  if (market.salesUrl) {
    try {
      log('  Enriching tenure from sales data...');
      const enriched = await enrichTenure(market, parcels);
      log(`  Enriched ${enriched || 0} parcels with tenure + owner data`);
    } catch(e) { log(`  Tenure enrichment failed: ${e.message}`); }
  }

  // === COMPUTE STATS + SCORE using the EXACT same model as briefing ===
  const stats = precomputeStats(parcels);
  
  // First pass: score without calibration
  let scores = parcels.map(p => scoreParcel(p, stats, null));

  // Compute calibration from backtest
  const cutoff24 = new Date(); cutoff24.setFullYear(cutoff24.getFullYear() - 2);
  const scored = parcels.map((p,i) => ({...p, ...scores[i]}));
  const sold24 = scored.filter(p => {
    if (!p.lastTransferDate) return false;
    const d = new Date(p.lastTransferDate);
    return d >= cutoff24 && (p.salePrice > 10000 || !p.salePrice);
  });
  
  let calibration = null;
  if (sold24.length >= 10) {
    const baseRate = sold24.length / scored.length;
    function fRate(fn) { const pool = scored.filter(fn), s = sold24.filter(fn); return pool.length > 0 ? s.length / pool.length : 0; }
    const rates = { 'All Properties': baseRate, 'Trusts': fRate(p=>p.cohort==='trust'), 'Estates / Heirs': fRate(p=>p.cohort==='estate'),
      'LLCs / Corps': fRate(p=>p.cohort==='investor'), 'Absentee Owners': fRate(p=>p._isAbsentee), 'Out-of-State': fRate(p=>p._isOutOfState),
      'Vacant Land': fRate(p=>p._isVacant), 'Named Individuals': fRate(p=>p.cohort==='residential') };
    const withTenure = scored.filter(p => p.tenureYears !== null && p.tenureYears !== undefined);
    if (withTenure.length > scored.length * 0.3) {
      rates['Tenure 0-3yr'] = fRate(p=>p.tenureYears!=null&&p.tenureYears<=3);
      rates['Tenure 3-10yr'] = fRate(p=>p.tenureYears!=null&&p.tenureYears>3&&p.tenureYears<=10);
      rates['Tenure 10-20yr'] = fRate(p=>p.tenureYears!=null&&p.tenureYears>10&&p.tenureYears<=20);
      rates['Tenure 20yr+'] = fRate(p=>p.tenureYears!=null&&p.tenureYears>20);
    }
    const lifts = {};
    for (const [k,r] of Object.entries(rates)) { if (k !== 'All Properties' && baseRate > 0) lifts[k] = r / baseRate; }
    
    // For backtest: re-score sold parcels WITHOUT tenure penalty
    // This simulates "would we have flagged them BEFORE they sold"
    // (sold parcels have tenureYears <= 2 which penalizes them — that's post-sale data)
    const sold24PreSale = sold24.map(p => {
      const preSale = {...p, tenureYears: null, lastTransferDate: null, lastTransferYear: null, tenureSource: null, tenureConfidence: null, recentTransfer: false, tenureLongTerm: true};
      const s = scoreParcel(preSale, stats, null);
      return {...preSale, ...s};
    });
    
    const avgSold = sold24PreSale.reduce((s,p) => s + p.briefingRank, 0) / sold24PreSale.length;
    const avgNotSold = scored.filter(p => !sold24.includes(p)).reduce((s,p) => s + p.briefingRank, 0) / (scored.length - sold24.length);
    
    // Recall at each threshold — what % of sold properties WOULD HAVE scored >= threshold before selling
    const thresholds = [25, 35, 45, 55];
    const recall = {};
    for (const t of thresholds) {
      const flagged = sold24PreSale.filter(p => p.briefingRank >= t).length;
      recall[t] = Math.round(flagged / sold24PreSale.length * 100);
    }
    
    calibration = { baseRate, lifts, rates, sold24: sold24.length, total: scored.length,
      avgScoreSold: Math.round(avgSold), avgScoreNotSold: Math.round(avgNotSold), scoreGap: Math.round(avgSold - avgNotSold),
      recall, wouldHaveFlagged: recall[35] };
    log(`  Cal: base=${(baseRate*100).toFixed(1)}%, ${sold24.length} sold, gap=${calibration.scoreGap > 0 ? '+' : ''}${calibration.scoreGap}`);
    
    // Second pass with calibration
    scores = parcels.map(p => scoreParcel(p, stats, calibration));
  } else {
    log(`  No cal (${sold24.length} sales)`);
  }

  // Rank
  let ranked = parcels.map((p,i) => ({p, s: scores[i]})).filter(x => x.s.briefingRank > 0).sort((a,b) => b.s.briefingRank - a.s.briefingRank);

  // === LISTING HISTORY ENRICHMENT ===
  // Cache-first architecture with write-back. The listing loop:
  //   1. Reads investigation_cache for all parcels we're about to check
  //   2. Uses cached listingSignals when available (zero SerpAPI cost)
  //   3. Falls through to live Zillow search for cache misses
  //   4. Writes results back to investigation_cache with _listingOnly marker
  //      so subsequent runs hit cache
  //
  // COST CONTROL — the previous version of this loop checked the top 150
  // parcels per ZIP, and the April 14 post-cleanup full sweep demonstrated
  // this cost ~14,000 SerpAPI searches across all markets (a single night's
  // cron run was nearly half the monthly Big Data cap at 30K). Root cause
  // of the sudden cost spike: previous cron runs had ~50% SerpAPI silent
  // failure rate which nobody noticed because errors return empty results,
  // making historical runs appear cheaper than they actually were. Once
  // SerpAPI was reliable, the full 14K cost came through.
  //
  // Fix: cap the check at 30 parcels per ZIP (top Act Today candidates
  // only, plus a small buffer for rank movement from listing boosts).
  // First-run cost drops from ~14K to ~2,800 searches. Subsequent runs
  // drop to near-zero because the write-back populates investigation_cache
  // for those same 30 parcels, so the next night's cron reads from cache.
  //
  // Why 30: Act Today floor is 30 cards per ZIP (commit 273938f), so
  // checking the top 30 by briefingRank covers every prospect an agent
  // will actually see in their first screen. Listing boosts of +20 can
  // move rank 50 → rank 30, but ranks below ~50 rarely contain the
  // life-event sellers this enrichment is meant to detect.
  const skipListing = process.argv.includes('--nolisting');
  if (!skipListing && process.env.SERPAPI_KEY) {
    const { searchGoogle } = require('./investigate');
    const listingCheckCount = Math.min(ranked.length, 30);
    log(`  Listing check: ${listingCheckCount} parcels...`);
    
    // Batch-fetch investigation_cache for every parcel we might check.
    // This is ONE round-trip to Supabase instead of 30 potential cache queries.
    const checkIds = ranked.slice(0, listingCheckCount).map(r => r.p.id);
    const { data: cachedRows } = await supabase
      .from('investigation_cache')
      .select('parcel_id, enhanced_claims, expires_at')
      .in('parcel_id', checkIds);
    
    const now = new Date();
    const listingCacheMap = new Map();
    for (const cr of (cachedRows || [])) {
      if (new Date(cr.expires_at) > now) {
        listingCacheMap.set(cr.parcel_id, cr.enhanced_claims || {});
      }
    }
    log(`  Listing cache: ${listingCacheMap.size}/${checkIds.length} parcels have cached research`);
    
    let boosted = 0;
    let freshSearches = 0;
    const listingUpserts = [];  // collect for single batch write at end
    
    for (let i = 0; i < listingCheckCount; i++) {
      const r = ranked[i];
      const addr = (r.p.address || '').replace(/\s+(BOZEMAN|SCOTTSDALE|CHARLOTTE|SEATTLE|BELLEVUE|MT|AZ|NC|WA|FL|NY|\d{5}).*/i, '').trim();
      if (!addr || addr.length < 5) continue;
      
      // RECENT-BUYER GUARD — skip listing history enrichment for parcels
      // whose current owner took ownership in the last 2 years. Any
      // "withdrawn / expired / off market" listing Zillow finds for a
      // recently-transacted property almost certainly belongs to the
      // PREVIOUS owner's failed sale attempt (list → withdraw → accept
      // different offer → close), not the current owner's intent. The
      // Rhythm & Reason Trust case at 1658 10TH ST W shipped with this
      // bug: the withdrawn listing was from the previous owner who sold
      // to the trust in Sep 2025, but the enrichment attributed it to
      // the trust and added +20 to rank. If the trust themselves try to
      // list next year, the scoring will detect it on that run.
      if (r.p.tenureYears !== undefined && r.p.tenureYears !== null && r.p.tenureYears <= 2) {
        continue;
      }
      
      // CACHE HIT — use stored listing signals instead of re-searching.
      // enhanced_claims.listingSignals is an array of pre-extracted detail
      // strings like "Property was listed but is now off market", "Price
      // reductions in history — motivated seller", "Has listing platform
      // history", "$193,552" (historical_price). We match the same patterns
      // the live path uses to decide boost and signal text.
      const cached = listingCacheMap.get(r.p.id);
      if (cached) {
        const listingSignals = cached.listingSignals || [];
        const joined = listingSignals.join(' ').toLowerCase();
        
        const wasListed = /off\s*market|removed|delisted|withdrawn|expired|cancelled|previously listed/.test(joined);
        const priceReduced = /price (cut|drop|reduced|change)|reduced by|motivated seller/.test(joined);
        const hasHistory = listingSignals.some(s => /listing platform history|zillow/i.test(s));
        
        if (wasListed) {
          r.s.briefingRank = Math.min(100, r.s.briefingRank + 20);
          r.s._listingBoost = 20;
          r.s._listingSignal = 'Previously listed — off market / withdrawn / expired (cached)';
          boosted++;
        } else if (priceReduced) {
          r.s.briefingRank = Math.min(100, r.s.briefingRank + 15);
          r.s._listingBoost = 15;
          r.s._listingSignal = 'Price reductions in listing history (cached)';
          boosted++;
        } else if (hasHistory) {
          r.s._listingSignal = 'Has Zillow listing page (cached)';
        }
        continue; // cache hit — no SerpAPI call needed
      }
      
      // CACHE MISS — fall through to live Zillow search. This is the only
      // path that burns SerpAPI budget in the listing enrichment loop.
      const city = r.p.ownerCity || r.p.city || 'Bozeman';
      freshSearches++;
      try {
        const results = await searchGoogle(`"${addr}" "${city}" site:zillow.com`);
        if (results && results.length > 0) {
          const text = results.map(x => `${x.title} ${x.snippet}`).join(' ').toLowerCase();
          
          const wasListed = /off\s*market|removed|delisted|withdrawn|expired|cancelled|previously listed/.test(text);
          const priceReduced = /price (cut|drop|reduced|change)|reduced by/.test(text);
          const hasHistory = results.some(x => /zillow\.com/.test(x.link || ''));
          
          // Build the listingSignals array that gets persisted to cache.
          // Use the same detail strings the investigation_cache reader expects.
          const listingSignals = [];
          if (wasListed) listingSignals.push('Property was listed but is now off market');
          if (priceReduced) listingSignals.push('Price reductions in history — motivated seller');
          if (hasHistory) listingSignals.push('Has listing platform history');
          
          if (wasListed) {
            r.s.briefingRank = Math.min(100, r.s.briefingRank + 20);
            r.s._listingBoost = 20;
            r.s._listingSignal = 'Previously listed — off market / withdrawn / expired';
            boosted++;
          } else if (priceReduced) {
            r.s.briefingRank = Math.min(100, r.s.briefingRank + 15);
            r.s._listingBoost = 15;
            r.s._listingSignal = 'Price reductions in listing history';
            boosted++;
          } else if (hasHistory) {
            r.s._listingSignal = 'Has Zillow listing page';
          }
          
          // WRITE-BACK: persist the listing check result to investigation_cache
          // with a _listingOnly marker so subsequent runs hit cache. We mark
          // _listingOnly=true so the Deep Signal fresh-investigation path knows
          // to treat this as a cache miss (it needs full identity/life-event
          // research, not just listing signals). When a parcel rises into the
          // top 5 and Deep Signal runs, it will overwrite this shallow row
          // with a complete investigation_cache entry.
          listingUpserts.push({
            parcel_id: r.p.id,
            zip_code: zip,
            search_count: 1,
            signal_count: listingSignals.length,
            signals: [],  // raw signals only populated by full investigation
            enhanced_claims: { listingSignals, _listingOnly: true },
            summary: { hasListingHistory: hasHistory, hasPreviousListing: wasListed },
            raw_result_count: results.length,
            investigated_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          });
        } else {
          // Even "no results" is worth caching — otherwise we'll re-check
          // this parcel every night forever. Mark it so the cache gate
          // still works but no boost is applied.
          listingUpserts.push({
            parcel_id: r.p.id,
            zip_code: zip,
            search_count: 1,
            signal_count: 0,
            signals: [],
            enhanced_claims: { listingSignals: [], _listingOnly: true, _noResults: true },
            summary: { hasListingHistory: false, hasPreviousListing: false },
            raw_result_count: 0,
            investigated_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          });
        }
      } catch(e) { /* skip */ }
      
      // Rate limit — only when we actually made a live call
      if (freshSearches % 8 === 0) await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    // Batch-write all listing upserts in one round trip
    if (listingUpserts.length > 0) {
      try {
        await supabase.from('investigation_cache').upsert(listingUpserts, { onConflict: 'parcel_id' });
        log(`  Listing cache: wrote ${listingUpserts.length} entries`);
      } catch(e) {
        log(`  Listing cache write failed: ${e.message}`);
      }
    }
    
    // Re-sort after boosts
    ranked.sort((a,b) => (b.s.lite_score || b.s.briefingRank) - (a.s.lite_score || a.s.briefingRank));
    log(`  Listing: ${boosted} boosted out of ${listingCheckCount} checked (${freshSearches} SerpAPI calls, ${listingCacheMap.size} cache hits)`);
  } else if (skipListing) {
    log(`  Listing check: skipped (--nolisting)`);
  }

  // === AI LITE SCORING ===
  if (!skipAI && anthropic) {
    const top = ranked.slice(0, 25);
    try {
      log(`  AI scoring ${top.length}...`);
      const d = top.map((r,i) => `[${i+1}] ${r.p.ownerName} — ${r.p.address}\n  ${r.s.cohortLabel} | $${(r.p.totalValue||0).toLocaleString()} | Abs:${r.p.isAbsentee?'Y':'N'} OOS:${r.p.isOutOfState?'Y':'N'} | Ten:${r.p.tenureYears!=null?r.p.tenureYears+'yr':'?'} | Multi:${r.s._multiCount}`).join('\n\n');
      const calCtx = calibration ? `\nCalibration: base ${(calibration.baseRate*100).toFixed(1)}%, trust ${(calibration.lifts['Trusts']||1).toFixed(2)}x` : '';
      // RECENT-BUYER RULE in the prompt so the AI respects tenure as a
      // dominant disqualifier. Without this, the AI was rubber-stamping
      // trust+absentee+high-value parcels at 90+ regardless of tenure.
      const aiP = anthropic.messages.create({ model:'claude-sonnet-4-20250514', max_tokens:2000,
        messages:[{role:'user',content:`Score seller likelihood 0-100. ONLY JSON: [{"idx":1,"score":72,"headline":"..."}]${calCtx}

CRITICAL RULE: Recent purchases are NOT sellers. Owners with tenure <= 1 year must score below 15 regardless of other signals. Owners with tenure <= 2 years must score below 30. Transaction costs alone make selling within a year of purchase economically irrational. Trust/absentee/high-value markers on a recent purchase usually indicate the BUYER's structure, not a seller signal — the previous owner is the one who sold.

${d}`}] });
      const r = await Promise.race([aiP, new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 60000))]);
      const arr = JSON.parse((r.content?.[0]?.text||'').replace(/```json|```/g,'').trim());
      let u = 0;
      if (Array.isArray(arr)) for (const a of arr) {
        const i=(a.idx||a.index)-1;
        if(i>=0 && i<top.length && a.score) {
          // Defensive cap: even if the AI ignored the recent-buyer rule,
          // never let lite_score exceed the heuristic briefingRank by more
          // than 15. The heuristic already capped briefingRank for recent
          // buyers, so this cap enforces tenure discipline on the AI output.
          const capped = Math.min(a.score, top[i].s.briefingRank + 15);
          top[i].s.lite_score = capped;
          top[i].s.lite_headline = a.headline || '';
          u++;
        }
      }
      log(`  AI: ${u}/${top.length}`);
    } catch(e) { log(`  AI failed: ${e.message}`); }
    ranked.sort((a,b) => (b.s.lite_score||b.s.briefingRank) - (a.s.lite_score||a.s.briefingRank));
  }

  // === DEEP SIGNAL ===
  // Reads investigation_cache (populated by worker-v2 AND by this worker's own
  // fresh-investigation path below) for grounded psychological profiling data.
  // When cached research exists for a top-5 parcel, we pass the extracted
  // signals + enhanced_claims into the LLM prompt so it can produce rich,
  // fact-grounded reports referencing real life events, identity markers,
  // demographics, and financial signals.
  //
  // CRITICAL CHANGE (Apr 13 2026): Previously this block only READ the cache
  // and never populated it. That meant rich Deep Signals only existed for
  // parcels worker-v2 had already investigated (439 parcels as of the April 4
  // worker-v2 run), with very low overlap against today's top-5 due to
  // scoring model changes (post-Rhythm-cap, post-Act-Today-floor, post-float-
  // fix). In practice: 1/5 Bellevue top-5 had cache hits, 0/5 Bozeman.
  //
  // Fix: for every top-5 parcel that doesn't have a cache hit, run
  // investigateParcel LIVE, write the result to investigation_cache with
  // 30-day TTL, and include it in this run's Deep Signal prompt. On the
  // first post-deploy batch across all 113 ZIPs, this costs roughly
  // 5 prospects × ~16 searches × 113 ZIPs = ~9,000 SerpAPI calls (a one-time
  // investment inside the Big Data 30K/mo plan). On subsequent batches, the
  // cost drops to near-zero because most top-5 parcels will already be
  // cached; only parcels that churn into the top 5 AND weren't previously
  // cached need fresh investigation.
  let pendingDS = [];
  if (!skipAI && anthropic) {
    const top = ranked.slice(0, 5);
    try {
      log(`  Deep Signal ${top.length}...`);
      
      // Fetch cached investigation data for the top 5 parcels
      const topIds = top.map(r => r.p.id);
      const { data: cachedInvs } = await supabase
        .from('investigation_cache')
        .select('parcel_id, signals, enhanced_claims, summary, investigated_at, expires_at')
        .in('parcel_id', topIds);
      
      const now = new Date();
      const invMap = new Map();
      let cacheHits = 0;
      for (const ci of (cachedInvs || [])) {
        if (new Date(ci.expires_at) > now) {
          // Skip _listingOnly rows — those are shallow listing-check results
          // written by the listing enrichment loop above. They don't contain
          // the full identity/life-event/demographic research that Deep
          // Signal needs. Treating them as cache hits would feed the LLM
          // an empty prompt with just a listing signal. Instead, treat them
          // as cache misses so the fresh-investigation path runs and
          // overwrites the shallow row with a complete investigation_cache
          // entry.
          const claims = ci.enhanced_claims || {};
          if (claims._listingOnly === true) continue;
          invMap.set(ci.parcel_id, ci);
          cacheHits++;
        }
      }
      
      // FRESH INVESTIGATION for top-5 parcels with no cache hit.
      // This is where we actually populate the rich research data that the
      // Deep Signal prompt depends on. Respects the --noinvest flag for
      // cost control and handles SerpAPI unavailability gracefully.
      const skipInvest = process.argv.includes('--noinvest') || !process.env.SERPAPI_KEY;
      let freshInvestigations = 0;
      if (!skipInvest) {
        const { investigateParcel } = require('./investigate');
        const needFresh = top.filter(r => !invMap.has(r.p.id));
        if (needFresh.length > 0) {
          log(`  Deep Signal: investigating ${needFresh.length} uncached top-5 parcels...`);
          for (const r of needFresh) {
            try {
              // Normalize parcel shape for investigateParcel
              const parcelForInvest = {
                id: r.p.id,
                owner_name: r.p.ownerName,
                address: r.p.address,
                city: r.p.ownerCity || r.p.city || r.p.situs_city || '',
                state: market.homeState || r.p.state || '',
              };
              const invResult = await investigateParcel(parcelForInvest);
              freshInvestigations++;
              
              // Upsert into investigation_cache with 30-day TTL so future
              // runs (and the on-demand /api/beta-research cache gate) can
              // read it without burning SerpAPI again.
              const invRow = {
                parcel_id: r.p.id,
                zip_code: zip,
                search_count: invResult.searchCount || 0,
                signal_count: (invResult.signals || []).length,
                signals: invResult.signals || [],
                enhanced_claims: invResult.enhancedClaims || {},
                summary: invResult.summary || {},
                raw_result_count: invResult.rawResultCount || 0,
                investigated_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              };
              await supabase.from('investigation_cache').upsert(invRow, { onConflict: 'parcel_id' });
              
              // Add to the live invMap so the prompt builder picks it up
              invMap.set(r.p.id, invRow);
              
              // Rate limit between investigations — investigateParcel itself
              // runs 14-25 searches in ~15-20s. Adding 1s spacing keeps us
              // well under SerpAPI's concurrent request limit.
              await new Promise(resolve => setTimeout(resolve, 1000));
            } catch(e) {
              log(`    Investigation failed for ${r.p.id}: ${e.message}`);
            }
          }
        }
      }
      
      log(`  Deep Signal: ${cacheHits} cache hits, ${freshInvestigations} fresh investigations, ${top.length - cacheHits - freshInvestigations} with no research`);
      
      // Build per-parcel prompt sections. When research is available, format
      // the findings prominently and instruct the LLM to ground claims in them.
      // When not, pass cohort context only and require honest acknowledgment.
      const promptSections = top.map((r, i) => {
        const inv = invMap.get(r.p.id);
        const base = `[${i+1}] ${r.p.ownerName} — ${r.p.address}, ${r.p.cityStateZip}
  ${r.s.cohortLabel} | $${(r.p.totalValue||0).toLocaleString()} | Mail: ${r.p.ownerAddress||'?'}
  Tenure: ${r.p.tenureYears!=null?r.p.tenureYears+'yr':'?'} | Heuristic score: ${r.s.briefingRank}`;
        
        if (!inv) {
          return base + `
  RESEARCH: None available. Write motivation based on cohort structure only, and explicitly note "limited public research surface" in the psychological profile. Do NOT fabricate life events or personal details. Use "The owner's [cohort type] structure suggests..." framing rather than inventing specifics.`;
        }
        
        const claims = inv.enhanced_claims || {};
        const lifeEvents = (claims.lifeEventSignals || []).join('; ');
        const identity = (claims.identitySignals || []).join('; ');
        const demographics = (claims.demographicSignals || []).join('; ');
        const financial = (claims.financialSignals || []).join('; ');
        const listing = (claims.listingSignals || []).join('; ');
        const blockers = (claims.blockerSignals || []).join('; ');
        const summary = inv.summary || {};
        
        const researchBlock = [
          lifeEvents && `  LIFE EVENTS: ${lifeEvents}`,
          identity && `  IDENTITY: ${identity}`,
          demographics && `  DEMOGRAPHICS: ${demographics}`,
          financial && `  FINANCIAL: ${financial}`,
          listing && `  LISTING HISTORY: ${listing}`,
          blockers && `  ⚠ BLOCKERS: ${blockers}`,
        ].filter(Boolean).join('\n');
        
        const signalTypes = (inv.signals || []).map(s => s.type).filter(Boolean);
        
        return base + `
  RESEARCH FINDINGS (from ${inv.signals?.length || 0} verified signals, investigated ${inv.investigated_at?.substring(0,10)}):
${researchBlock || '  (no categorized signals)'}
  Signal types detected: ${signalTypes.join(', ') || 'none'}`;
      }).join('\n\n');
      
      const p = anthropic.messages.create({ 
        model:'claude-sonnet-4-20250514', 
        max_tokens:8000,
        messages:[{role:'user',content:`You are SellerSignal's Deep Signal engine. You produce grounded psychological profiles and outreach strategies for real estate prospects.

CRITICAL DATA HONESTY RULES:
1. When research findings are provided, GROUND every claim in them. Reference specific life events, identity markers, and demographic signals by name. If research shows "Retirement indicator from LinkedIn", say "LinkedIn signals suggest recent retirement" — not "the owner may be contemplating life changes."
2. When research findings show NONE or are not provided, SAY SO HONESTLY. Write "Limited public research surface on this owner — analysis based on parcel structure only" as the opening of your psychological profile. Do NOT fabricate life events, family situations, or demographic details.
3. NEVER use cohort pattern-matching as your primary content. "Trust + absentee = sophisticated wealth management" is NOT a psychological profile — it's a tautology. Trust structures are a COHORT LABEL, not a psychological insight.
4. Rich psychological profiling means: specific to this person, grounded in evidence, actionable by an agent. If you don't have specifics, say you don't have them.

OUTPUT FORMAT:
Respond with ONLY a JSON array (one entry per prospect). Each entry:
{
  "idx": 1,
  "motivation": "3-5 sentences grounded in research findings. When findings are present, reference them specifically. When absent, acknowledge 'Limited public research' and speak only to cohort structure.",
  "timeline": "0-3 months | 3-6 months | 6-12 months | 12+ months",
  "best_channel": "call | mail | door",
  "call_script": "Full 4-6 sentence phone script. When research is present, reference at least 2 specific findings naturally. When absent, keep it simple and respectful — do not fabricate context.",
  "mail_script": "Full 4-6 sentence letter. Same grounding rules as call_script.",
  "door_script": "Full 4-6 sentence door knock. Should feel informed when research is present, respectful and generic when not.",
  "what_not_to_say": "2-3 specific things to avoid, tied to either (a) what research reveals or (b) cohort-appropriate respect. Not generic 'do not be pushy.'",
  "research_grounded": true | false
}

Set research_grounded to TRUE only if the prospect had actual research findings. Set to FALSE for parcels with no research — this tells the UI to display the appropriate badge.

PROSPECTS:
${promptSections}`}] 
      });
      const r = await Promise.race([p, new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 120000))]);
      const arr = JSON.parse((r.content?.[0]?.text||'').replace(/```json|```/g,'').trim());
      if (Array.isArray(arr)) {
        for (const ds of arr) { 
          const i=(ds.idx||ds.index)-1; 
          if(i>=0&&i<top.length) pendingDS.push({
            parcel_id:top[i].p.id,
            zip_code:zip,
            report:ds,
            motivation:ds.motivation||null,
            timeline:ds.timeline||null,
            best_channel:ds.best_channel||null,
            call_script:ds.call_script||null,
            mail_script:ds.mail_script||null,
            door_script:ds.door_script||null,
            what_not_to_say:ds.what_not_to_say||null,
            generated_at:new Date().toISOString()
          }); 
        }
        log(`  DS: ${pendingDS.length} generated (${cacheHits} with research)`);
      }
    } catch(e) { log(`  DS failed: ${e.message}`); }
  }

  // === DEDUP ===
  const seen = new Set();
  const uP = parcels.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
  const seen2 = new Set();
  const uR = ranked.filter(r => { if (seen2.has(r.p.id)) return false; seen2.add(r.p.id); return true; });
  if (uP.length < parcels.length) log(`  Dedup: ${parcels.length} → ${uP.length}`);

  // === STORE PARCELS ===
  log(`  Storing ${uP.length} parcels...`);
  // Build a map of parcel_id → scored cohort for storage
  const cohortMap = {};
  for (const r of uR) cohortMap[r.p.id] = r.s.cohort || 'residential';
  
  // Helper: coerce a value to integer or null for INTEGER-typed columns.
  // Philadelphia OPA returns market_value / taxable_building / taxable_land
  // as floats with decimals (e.g. "577523.44"), which Postgres rejects when
  // inserted into our INTEGER columns with "invalid input syntax for type
  // integer". This silently killed the Philly parcels upsert: every batch
  // containing a float-valued parcel got rolled back, which then cascaded
  // into FK violations on parcel_scores and deep_signals (parent rows
  // never got written). Only the handful of batches with all-integer values
  // survived, and by survivorship bias those were all plain residentials
  // that scored to rank 33 — which looked like a scoring bug but was
  // actually a data-type bug.
  //
  // Fix: round every INTEGER-column value to an integer at the upsert site.
  // We keep parseNumericValue as-is because acres (DOUBLE PRECISION) still
  // needs decimal precision. Integer columns: assessed_value, building_value,
  // land_value, sqft, bedrooms, multi_count, sale_price.
  const asInt = v => (v == null || v === '' || isNaN(v)) ? null : Math.round(Number(v));
  
  for (let i = 0; i < uP.length; i += 500) {
    const batch = uP.slice(i, i+500).map(p => ({
      id:p.id, zip_code:zip, market_key:market.key,
      owner_name:p.ownerName, owner_type:cohortMap[p.id]||'residential',
      address:p.address, city:p.ownerCity||'', state:market.homeState,
      lat:p.lat||null, lng:p.lng||null,
      assessed_value:asInt(p.totalValue), building_value:asInt(p.buildingValue), land_value:asInt(p.landValue),
      year_built:asInt(p.yearBuilt), sqft:asInt(p.sqft), bedrooms:asInt(p.bedrooms),
      acres:p.acres||null, subdivision:p.subdivision||null,
      prop_type:p.propType||'Residential', is_vacant_land:!!p.isVacantLand,
      is_absentee:!!p.isAbsentee, is_out_of_state:!!p.isOutOfState,
      owner_state:p.ownerState||null,
      mailing_address:p.ownerAddress||null, mailing_city:p.ownerCity||null,
      mailing_state:p.ownerState||null, mailing_zip:p.ownerZip||null,
      multi_count:asInt(p.multiCount) || 1,
      last_transfer_year:asInt(p.lastTransferYear), last_transfer_date:p.lastTransferDate||null,
      sale_price:asInt(p.salePrice), tenure_years:p.tenureYears,
      fetched_at:new Date().toISOString(), updated_at:new Date().toISOString(),
    }));
    const { error } = await supabase.from('parcels').upsert(batch, { onConflict: 'id' });
    if (error) log(`  Parcel err: ${error.message}`);
  }

  // === STORE SCORES ===
  for (let i = 0; i < uR.length; i += 500) {
    const batch = uR.slice(i, i+500).map(r => ({
      parcel_id:r.p.id, zip_code:zip, market_key:market.key,
      seller_likelihood:r.s.sellerLikelihood, off_market_receptivity:r.s.offMarketReceptivity,
      actionability:r.s.actionability, confidence:r.s.confidence,
      briefing_rank:r.s.briefingRank, score_class:r.s.scoreClass, cohort:r.s.cohort,
      calibrated_rank:r.s.briefingRank,
      ...(r.s.lite_score ? {lite_score:r.s.lite_score, lite_headline:r.s.lite_headline||''} : {}),
      ...(r.s._listingSignal ? {signals: [{text: r.s._listingSignal, type: 'listing'}]} : {}),
      scored_at:new Date().toISOString(),
    }));
    const { error } = await supabase.from('parcel_scores').upsert(batch, { onConflict: 'parcel_id' });
    if (error) log(`  Score err: ${error.message}`);
  }

  // === PREDICTION SNAPSHOTS — time-series capture for ML training + accuracy validation ===
  // Snapshot every meaningfully scored parcel (rank >= 10) so we have a permanent record
  // of what we predicted and when. Used to validate accuracy when sales are detected later.
  try {
    const now = new Date().toISOString();
    const batchRunId = `batch_${zip}_${Date.now()}`;
    const snapshots = uR
      .filter(r => r.s.briefingRank >= 10)
      .map(r => ({
        parcel_id: r.p.id,
        zip_code: zip,
        market_key: market.key,
        briefing_rank: r.s.briefingRank,
        calibrated_rank: r.s.briefingRank,
        cohort: r.s.cohort || null,
        lite_score: r.s.lite_score || null,
        snapshot_date: now,
        batch_run_id: batchRunId,
        owner_name: r.p.ownerName || null,
        owner_type: cohortMap[r.p.id] || 'residential',
        is_absentee: !!r.p.isAbsentee,
        is_out_of_state: !!r.p.isOutOfState,
      }));
    
    let snapshotCount = 0;
    for (let i = 0; i < snapshots.length; i += 500) {
      const slice = snapshots.slice(i, i+500);
      const { error } = await supabase.from('prediction_snapshots').insert(slice);
      if (error) {
        log(`  Snapshot err (batch ${i}): ${error.message}`);
        break;
      }
      snapshotCount += slice.length;
    }
    if (snapshotCount > 0) log(`  Prediction snapshots: ${snapshotCount} captured for training data`);
  } catch(e) {
    log(`  Snapshot error: ${e.message}`);
  }

  // === STORE DEEP SIGNALS ===
  if (pendingDS.length > 0) {
    const dsM = new Map(); for (const r of pendingDS) dsM.set(r.parcel_id, r);
    const dd = [...dsM.values()];
    const { error } = await supabase.from('deep_signals').upsert(dd, { onConflict: 'parcel_id' });
    if (error) log(`  DS store err: ${error.message}`);
    else log(`  DS stored: ${dd.length}`);
  }

  // === STORE BRIEFING ===
  // Act Today = number of owners to display as highest-conviction leads for the day.
  // 
  // The underlying goal is "match real monthly turnover" — if the ZIP actually sells
  // ~17 homes/month, we ideally want to show 17 Act Today cards. But that creates a
  // problem in dense urban markets where the calibration-derived count drops to
  // single digits, which looks broken in demos compared to high-turnover luxury
  // suburbs where the same logic produces 80-100+ cards.
  //
  // Fix: enforce a minimum floor of 30 Act Today cards in every ZIP regardless of
  // calibrated turnover. This gives agents in every market a demo-viable prospect
  // list without inflating claims — we're just showing the top 30 highest-scoring
  // owners instead of strictly matching monthly turnover count. For markets with
  // genuinely high turnover (Paradise Valley, Belle Meade, etc.) the calibrated
  // count still wins since it's already well above 30.
  const sorted = uR.sort((a,b) => b.s.briefingRank - a.s.briefingRank);
  const ACT_TODAY_FLOOR = 30;
  const monthlySellers = calibration?.sold24 ? Math.ceil(calibration.sold24 / 24) : Math.max(20, Math.ceil(parcels.length * 0.003));
  const targetActCount = Math.max(monthlySellers, ACT_TODAY_FLOOR);
  
  const actCands = sorted.slice(0, targetActCount).filter(r => r.s.briefingRank >= 15);
  const actIds = new Set(actCands.map(r => r.p.id));
  // Outreach = next tier beyond Act Today — 3-6 month horizon prospects
  const outSize = Math.min(targetActCount * 2, sorted.length - actCands.length);
  const outCands = sorted.slice(actCands.length, actCands.length + outSize).filter(r => r.s.briefingRank >= 10 && !actIds.has(r.p.id));
  
  await supabase.from('zip_briefings').upsert({
    zip_code:zip, market_key:market.key, market_name:market.name,
    total_parcels:parcels.length,
    unique_owners:new Set(parcels.map(p=>p.ownerName.toUpperCase())).size,
    act_today_count:actCands.length,
    outreach_queue_count:outCands.length,
    act_today_ids:actCands.slice(0,15).map(r=>r.p.id),
    outreach_queue_ids:outCands.slice(0,50).map(r=>r.p.id),
    calibration:calibration||null,
    computed_at:new Date().toISOString(),
    computation_time_ms:Date.now()-t0,
  }, { onConflict: 'zip_code' });

  log(`  DONE: ${uP.length} parcels, ${actCands.length} act today, ${outCands.length} outreach, ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
  return { zip, parcels: uP.length, actToday: actCands.length };
}

async function main() {
  if (!supabase) { console.error('SUPABASE_URL + SUPABASE_SERVICE_KEY required'); process.exit(1); }
  let zips = [];
  if (targetZip) { const m = getMarketForZip(targetZip); if(!m){console.error('Unknown ZIP');process.exit(1);} zips=[{zip:targetZip,market:m}]; }
  else if (targetMarket) { const m = MARKETS[targetMarket]; if(!m){console.error('Unknown market. Available: '+Object.keys(MARKETS).join(', '));process.exit(1);} zips=m.zips.map(z=>({zip:z,market:m})); }
  else zips = getAllZips().map(z => ({zip:z.zip, market:MARKETS[z.marketKey]}));

  log(`SellerSignal Batch — ${zips.length} ZIPs${skipAI ? ' (no AI)' : ' (AI + Deep Signal)'}`);
  const { data: run } = await supabase.from('batch_runs').insert({ started_at: new Date().toISOString(), status: 'running' }).select('id').single();
  
  let tP = 0, tA = 0, errs = [];
  for (const { zip, market } of zips) {
    try {
      const r = await processZip(zip, market);
      if (r) { tP += r.parcels; tA += r.actToday; }
      await new Promise(r => setTimeout(r, 1500));
    } catch(e) {
      log(`  FAILED: ${zip} — ${e.message}`);
      errs.push({ zip, error: e.message });
    }
  }
  
  if (run?.id) await supabase.from('batch_runs').update({
    completed_at: new Date().toISOString(),
    status: errs.length ? 'completed_with_errors' : 'completed',
    zips_processed: zips.length - errs.length, parcels_processed: tP,
    errors: errs.length ? errs : null,
  }).eq('id', run.id);
  
  log(`\n=== DONE: ${zips.length-errs.length}/${zips.length} ZIPs | ${tP.toLocaleString()} parcels | ${tA} act today ===`);
  
  // ========================================
  // AUTO SALE DETECTION — cross-reference new sales against previously scored parcels
  // ========================================
  log('\nRunning sale detection...');
  try {
    // Get all parcels that have a recent sale_price (sold recently)
    const { data: recentSales } = await supabase.from('parcels')
      .select('id, zip_code, owner_name, address, sale_price, last_transfer_date')
      .not('sale_price', 'is', null)
      .gt('sale_price', 50000);
    
    if (recentSales?.length) {
      // Get all previously scored parcels
      const { data: scoredParcels } = await supabase.from('parcel_scores')
        .select('parcel_id, zip_code, briefing_rank, cohort, lite_score');
      
      const scoreMap = {};
      for (const s of (scoredParcels || [])) scoreMap[s.parcel_id] = s;
      
      let detected = 0;
      let validated = 0;
      for (const sale of recentSales) {
        const scored = scoreMap[sale.id];
        if (!scored || scored.briefing_rank < 25) continue; // only track meaningful scores
        
        // Check if we already recorded this detection
        const { data: existing } = await supabase.from('sale_detections')
          .select('id').eq('parcel_id', sale.id).limit(1);
        
        if (existing?.length) continue; // already recorded
        
        await supabase.from('sale_detections').insert({
          parcel_id: sale.id,
          zip_code: sale.zip_code,
          owner_name: sale.owner_name,
          address: sale.address,
          sale_price: sale.sale_price,
          sale_date: sale.last_transfer_date,
          score_at_flag: scored.briefing_rank,
          cohort: scored.cohort,
          detected_at: new Date().toISOString(),
        });
        detected++;
        
        // === PREDICTION VALIDATION — query the snapshot history for this parcel ===
        try {
          const { data: snapshots } = await supabase.from('prediction_snapshots')
            .select('briefing_rank, cohort, snapshot_date, market_key')
            .eq('parcel_id', sale.id)
            .order('snapshot_date', { ascending: true });
          
          if (snapshots && snapshots.length > 0) {
            const first = snapshots[0];
            const last = snapshots[snapshots.length - 1];
            const saleDate = sale.last_transfer_date;
            const firstDate = new Date(first.snapshot_date);
            const saleDt = new Date(saleDate);
            const daysFromFirst = Math.round((saleDt - firstDate) / (1000 * 60 * 60 * 24));
            
            const everActToday = snapshots.some(s => s.cohort === 'act_today');
            const everOutreach = snapshots.some(s => s.cohort === 'outreach');
            
            await supabase.from('prediction_validations').upsert({
              parcel_id: sale.id,
              zip_code: sale.zip_code,
              market_key: first.market_key,
              sale_date: saleDate,
              sale_price: sale.sale_price,
              first_flagged_date: first.snapshot_date,
              first_flagged_score: first.briefing_rank,
              first_flagged_cohort: first.cohort,
              days_from_first_flag: daysFromFirst,
              last_score_before_sale: last.briefing_rank,
              last_cohort_before_sale: last.cohort,
              last_score_date: last.snapshot_date,
              ever_act_today: everActToday,
              ever_outreach: everOutreach,
              snapshot_count: snapshots.length,
              validated_at: new Date().toISOString(),
            }, { onConflict: 'parcel_id' });
            validated++;
          }
        } catch(ve) {
          log(`  Validation err for ${sale.id}: ${ve.message}`);
        }
      }
      
      log(`  Sale detection: ${detected} new confirmed sales from previously scored parcels`);
      if (validated > 0) log(`  Prediction validations: ${validated} predictions linked to actual outcomes`);
    }
  } catch(e) {
    log(`  Sale detection error: ${e.message}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
