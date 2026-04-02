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
      if (p.address && p.address.length >= 3) parcels.push(p);
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

  // === AI LITE SCORING ===
  if (!skipAI && anthropic) {
    const top = ranked.slice(0, 25);
    try {
      log(`  AI scoring ${top.length}...`);
      const d = top.map((r,i) => `[${i+1}] ${r.p.ownerName} — ${r.p.address}\n  ${r.s.cohortLabel} | $${(r.p.totalValue||0).toLocaleString()} | Abs:${r.p.isAbsentee?'Y':'N'} OOS:${r.p.isOutOfState?'Y':'N'} | Ten:${r.p.tenureYears!=null?r.p.tenureYears+'yr':'?'} | Multi:${r.s._multiCount}`).join('\n\n');
      const calCtx = calibration ? `\nCalibration: base ${(calibration.baseRate*100).toFixed(1)}%, trust ${(calibration.lifts['Trusts']||1).toFixed(2)}x` : '';
      const aiP = anthropic.messages.create({ model:'claude-sonnet-4-20250514', max_tokens:2000,
        messages:[{role:'user',content:`Score seller likelihood 0-100. ONLY JSON: [{"idx":1,"score":72,"headline":"..."}]${calCtx}\n\n${d}`}] });
      const r = await Promise.race([aiP, new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 60000))]);
      const arr = JSON.parse((r.content?.[0]?.text||'').replace(/```json|```/g,'').trim());
      let u = 0;
      if (Array.isArray(arr)) for (const a of arr) { const i=(a.idx||a.index)-1; if(i>=0&&i<top.length&&a.score){top[i].s.lite_score=a.score;top[i].s.lite_headline=a.headline||'';u++;} }
      log(`  AI: ${u}/${top.length}`);
    } catch(e) { log(`  AI failed: ${e.message}`); }
    ranked.sort((a,b) => (b.s.lite_score||b.s.briefingRank) - (a.s.lite_score||a.s.briefingRank));
  }

  // === DEEP SIGNAL ===
  let pendingDS = [];
  if (!skipAI && anthropic) {
    const top = ranked.slice(0, 5);
    try {
      log(`  Deep Signal ${top.length}...`);
      const d = top.map((r,i) => `[${i+1}] ${r.p.ownerName} — ${r.p.address}, ${r.p.cityStateZip}\n  ${r.s.cohortLabel} | $${(r.p.totalValue||0).toLocaleString()} | Mail: ${r.p.ownerAddress||'?'}\n  Tenure: ${r.p.tenureYears!=null?r.p.tenureYears+'yr':'?'} | AI: ${r.s.lite_score||'?'} ${r.s.lite_headline||''}`).join('\n\n');
      const p = anthropic.messages.create({ model:'claude-sonnet-4-20250514', max_tokens:8000,
        messages:[{role:'user',content:`You are SellerSignal's Deep Signal engine. For each prospect, produce a DETAILED intelligence report. Scripts should be FULL PARAGRAPHS (4-6 sentences) that an agent can use verbatim.

Respond with ONLY a JSON array. Each entry:
{"idx":1,"motivation":"3-4 sentence analysis referencing specific data: tenure, mailing state, trust structure, portfolio.","timeline":"3-6 months","best_channel":"call|mail|door","call_script":"Full 4-6 sentence phone script. Reference property, owner situation, position yourself as problem solver, soft close.","mail_script":"Full 4-6 sentence letter. Professional, specific to their property and situation.","door_script":"Full 4-6 sentence door knock. Warm, specific, leave-behind offer.","what_not_to_say":"2-3 specific things to avoid and WHY for this owner type."}

PROSPECTS:\n${d}`}] });
      const r = await Promise.race([p, new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 120000))]);
      const arr = JSON.parse((r.content?.[0]?.text||'').replace(/```json|```/g,'').trim());
      if (Array.isArray(arr)) {
        for (const ds of arr) { const i=(ds.idx||ds.index)-1; if(i>=0&&i<top.length) pendingDS.push({parcel_id:top[i].p.id,zip_code:zip,report:ds,motivation:ds.motivation||null,timeline:ds.timeline||null,best_channel:ds.best_channel||null,call_script:ds.call_script||null,mail_script:ds.mail_script||null,door_script:ds.door_script||null,what_not_to_say:ds.what_not_to_say||null,generated_at:new Date().toISOString()}); }
        log(`  DS: ${pendingDS.length} generated`);
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
  for (let i = 0; i < uP.length; i += 500) {
    const batch = uP.slice(i, i+500).map(p => ({
      id:p.id, zip_code:zip, market_key:market.key,
      owner_name:p.ownerName, owner_type:p.cohort||'residential',
      address:p.address, city:p.ownerCity||'', state:market.homeState,
      lat:p.lat||null, lng:p.lng||null,
      assessed_value:p.totalValue||null, building_value:p.buildingValue||null, land_value:p.landValue||null,
      year_built:p.yearBuilt||null, sqft:p.sqft||null, bedrooms:p.bedrooms||null,
      acres:p.acres||null, subdivision:p.subdivision||null,
      prop_type:p.propType||'Residential', is_vacant_land:!!p.isVacantLand,
      is_absentee:!!p.isAbsentee, is_out_of_state:!!p.isOutOfState,
      owner_state:p.ownerState||null,
      mailing_address:p.ownerAddress||null, mailing_city:p.ownerCity||null,
      mailing_state:p.ownerState||null, mailing_zip:p.ownerZip||null,
      multi_count:p.multiCount||1,
      last_transfer_year:p.lastTransferYear||null, last_transfer_date:p.lastTransferDate||null,
      sale_price:p.salePrice||null, tenure_years:p.tenureYears,
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
      scored_at:new Date().toISOString(),
    }));
    const { error } = await supabase.from('parcel_scores').upsert(batch, { onConflict: 'parcel_id' });
    if (error) log(`  Score err: ${error.message}`);
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
  const actCands = uR.filter(r => (r.s.lite_score||r.s.briefingRank) >= 55);
  const outCands = uR.filter(r => { const s=r.s.lite_score||r.s.briefingRank; return s>=35&&s<55; });
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
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
