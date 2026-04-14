// ============================================================================
// RESCORE WITH SIGNALS
// ============================================================================
// Reads parcels + investigation_cache from Supabase and updates parcel_scores
// using scoreParcelNew() — the new investigation-driven scoring function.
// 
// Does NOT run any SerpAPI calls. Pure database pass.
// 
// Usage:
//   node batch/rescore-with-signals.js --zip 85253              # one ZIP dry-run
//   node batch/rescore-with-signals.js --zip 85253 --write      # one ZIP, write results
//   node batch/rescore-with-signals.js --market AZ_MARICOPA --write
//   node batch/rescore-with-signals.js --all --write            # all markets
//   node batch/rescore-with-signals.js --zip 85253 --compare    # show top-20 before/after
// ============================================================================

// Usage: export SUPABASE_SERVICE_KEY=... before running, or set via Railway env.
// This script does not use dotenv — it relies on the env being set by the caller.
const { createClient } = require('@supabase/supabase-js');
const { scoreParcelNew, precomputeStats } = require('./pipeline');
const { MARKETS } = require('./markets');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://eeqsbvizgpuehphiaslo.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_KEY) {
    console.error('Missing SUPABASE_SERVICE_KEY env var');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Parse args
const args = process.argv.slice(2);
const opts = {
    zip: null,
    market: null,
    all: false,
    write: false,
    compare: false,
    limit: null,
};
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--zip') opts.zip = args[++i];
    else if (args[i] === '--market') opts.market = args[++i];
    else if (args[i] === '--all') opts.all = true;
    else if (args[i] === '--write') opts.write = true;
    else if (args[i] === '--compare') opts.compare = true;
    else if (args[i] === '--limit') opts.limit = parseInt(args[++i]);
}

// ============================================================================
// Convert a database `parcels` row to the shape scoreParcelNew expects.
// The DB column naming differs from the parseParcel() output — this is the
// normalization layer.
// ============================================================================
function dbParcelToScoreInput(row) {
    return {
        id: row.id,
        ownerName: row.owner_name || '',
        address: row.address || '',
        cityStateZip: '',
        totalValue: row.assessed_value || 0,
        buildingValue: row.building_value || 0,
        landValue: row.land_value || 0,
        ownerAddress: row.mailing_address || '',
        ownerCity: row.mailing_city || '',
        ownerState: row.mailing_state || row.owner_state || '',
        ownerZip: row.mailing_zip || '',
        isAbsentee: row.is_absentee || false,
        isOutOfState: row.is_out_of_state || false,
        mailDiffers: row.is_absentee || false,
        propType: row.prop_type || '',
        ptResult: { isExempt: false, isCommercial: row.prop_type === 'Commercial' },
        isVacant: row.is_vacant_land || false,
        lat: row.lat || 0,
        lng: row.lng || 0,
        acres: row.acres || 0,
        yearBuilt: row.year_built || null,
        livingSpace: row.sqft || 0,
        bedrooms: row.bedrooms || 0,
        exempt: false,
        subdivision: row.subdivision || '',
        multiCount: row.multi_count || 1,
        lastTransferYear: row.last_transfer_year || null,
        lastTransferDate: row.last_transfer_date || null,
        salePrice: row.sale_price || null,
        tenureYears: row.tenure_years,
        tenureSource: row.last_transfer_date ? 'deed' : null,
        tenureConfidence: row.tenure_years !== null ? 'high' : null,
        tenureLongTerm: row.tenure_years !== null ? row.tenure_years >= 3 : true,
        quitClaimFlag: false,  // TODO: pull from raw_attributes if available
    };
}

// ============================================================================
// Get all ZIPs to process
// ============================================================================
function getZipsToProcess() {
    if (opts.zip) return [opts.zip];
    if (opts.market) {
        const m = MARKETS[opts.market];
        if (!m) { console.error(`Unknown market: ${opts.market}`); process.exit(1); }
        return m.zips;
    }
    if (opts.all) {
        const zips = [];
        for (const mk of Object.keys(MARKETS)) {
            zips.push(...(MARKETS[mk].zips || []));
        }
        return zips;
    }
    console.error('Must specify --zip, --market, or --all');
    process.exit(1);
}

// ============================================================================
// Process one ZIP
// ============================================================================
async function processZip(zip) {
    const startTs = Date.now();
    console.log(`\n=== ZIP ${zip} ===`);
    
    // Fetch all parcels for this ZIP (paginated)
    const allParcels = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
        const { data: page, error } = await supabase
            .from('parcels')
            .select('*')
            .eq('zip_code', zip)
            .range(offset, offset + pageSize - 1);
        if (error) { console.error(`  Parcels fetch error: ${error.message}`); return; }
        if (!page || page.length === 0) break;
        allParcels.push(...page);
        offset += pageSize;
        if (page.length < pageSize) break;
        if (opts.limit && allParcels.length >= opts.limit) break;
    }
    
    if (opts.limit) allParcels.splice(opts.limit);
    
    console.log(`  Loaded ${allParcels.length} parcels`);
    if (allParcels.length === 0) return;
    
    // Fetch investigation_cache for this ZIP (all entries, skip _listingOnly)
    const { data: invRows, error: invErr } = await supabase
        .from('investigation_cache')
        .select('parcel_id, signals, enhanced_claims')
        .eq('zip_code', zip);
    if (invErr) { console.error(`  Investigation fetch error: ${invErr.message}`); return; }
    
    const invByParcelId = new Map();
    let listingOnlyCount = 0;
    for (const r of (invRows || [])) {
        const ec = r.enhanced_claims || {};
        if (ec._listingOnly) { listingOnlyCount++; continue; }
        invByParcelId.set(r.parcel_id, r.signals || []);
    }
    console.log(`  Investigation cache: ${invByParcelId.size} full + ${listingOnlyCount} listing-only (skipped)`);
    
    // Fetch existing parcel_scores for comparison (old rank)
    const { data: oldScores, error: oldErr } = await supabase
        .from('parcel_scores')
        .select('parcel_id, briefing_rank, seller_likelihood, cohort')
        .eq('zip_code', zip);
    if (oldErr) { console.error(`  Old scores fetch error: ${oldErr.message}`); return; }
    const oldByParcelId = new Map((oldScores || []).map(s => [s.parcel_id, s]));
    
    // Compute stats (p75Value, ownerCounts) — matches precomputeStats contract
    const parsedParcels = allParcels.map(dbParcelToScoreInput);
    const stats = precomputeStats(parsedParcels);
    
    // Score everything with scoreParcelNew
    const scored = [];
    for (const parsed of parsedParcels) {
        const sigs = invByParcelId.get(parsed.id) || null;
        const result = scoreParcelNew(parsed, stats, null, sigs);
        scored.push({
            parcel_id: parsed.id,
            zip_code: zip,
            market_key: allParcels.find(p => p.id === parsed.id)?.market_key || null,
            seller_likelihood: result.sellerLikelihood,
            off_market_receptivity: result.offMarketReceptivity,
            actionability: result.actionability,
            confidence: result.confidence,
            briefing_rank: result.briefingRank,
            score_class: result.scoreClass,
            cohort: result.cohort,
            signals: result.signals,
            _hasInvestigation: result._hasInvestigation,
            _investigationScore: result._investigationScore,
            _shapeScore: result._shapeScore,
        });
    }
    
    // Report summary
    const withInv = scored.filter(s => s._hasInvestigation).length;
    const agents = scored.filter(s => s.cohort === 'agent').length;
    const recentBuyers = scored.filter(s => s.cohort === 'recent_buyer').length;
    const topSL = scored.filter(s => s.seller_likelihood >= 55).length;
    const midSL = scored.filter(s => s.seller_likelihood >= 35 && s.seller_likelihood < 55).length;
    
    console.log(`  Scored: ${scored.length}`);
    console.log(`    with investigation: ${withInv}`);
    console.log(`    blocked agents: ${agents}`);
    console.log(`    blocked recent buyers: ${recentBuyers}`);
    console.log(`    sellerLikelihood >= 55: ${topSL}`);
    console.log(`    sellerLikelihood 35-54: ${midSL}`);
    
    // Compare mode — show top 20 before/after
    if (opts.compare) {
        const parcelById = new Map(allParcels.map(p => [p.id, p]));
        
        // New ranking
        const sortedNew = [...scored].sort((a, b) => (b.briefing_rank - a.briefing_rank) || (b.seller_likelihood - a.seller_likelihood));
        console.log(`\n  NEW top 20 (investigation-driven):`);
        for (let i = 0; i < Math.min(20, sortedNew.length); i++) {
            const s = sortedNew[i];
            const p = parcelById.get(s.parcel_id) || {};
            const old = oldByParcelId.get(s.parcel_id) || {};
            const valS = p.assessed_value ? (p.assessed_value >= 1e6 ? `$${(p.assessed_value/1e6).toFixed(1)}M` : `$${Math.round(p.assessed_value/1e3)}K`) : '?';
            const owner = (p.owner_name || '?').slice(0, 35);
            const topSig = (s.signals && s.signals[0]) ? s.signals[0].text.slice(0, 70) : '(no signal)';
            const invFlag = s._hasInvestigation ? '✓' : ' ';
            console.log(`    ${String(i+1).padStart(3)} ${invFlag} new=${s.briefing_rank} sl=${s.seller_likelihood} old=${old.briefing_rank||0} ${owner.padEnd(35)} ${valS.padEnd(9)} ${topSig}`);
        }
        
        // Compare to old top 20
        const sortedOld = (oldScores || []).sort((a, b) => b.briefing_rank - a.briefing_rank);
        console.log(`\n  OLD top 20 (property-shape):`);
        for (let i = 0; i < Math.min(20, sortedOld.length); i++) {
            const s = sortedOld[i];
            const p = parcelById.get(s.parcel_id) || {};
            const newScore = scored.find(x => x.parcel_id === s.parcel_id);
            const valS = p.assessed_value ? (p.assessed_value >= 1e6 ? `$${(p.assessed_value/1e6).toFixed(1)}M` : `$${Math.round(p.assessed_value/1e3)}K`) : '?';
            const owner = (p.owner_name || '?').slice(0, 35);
            console.log(`    ${String(i+1).padStart(3)}   old=${s.briefing_rank} sl=${s.seller_likelihood} new=${newScore?.briefing_rank||0} ${owner.padEnd(35)} ${valS}`);
        }
    }
    
    // Write mode — upsert parcel_scores
    if (opts.write) {
        // Clean the rows before writing — strip internal fields
        const toWrite = scored.map(s => ({
            parcel_id: s.parcel_id,
            zip_code: s.zip_code,
            market_key: s.market_key,
            seller_likelihood: s.seller_likelihood,
            off_market_receptivity: s.off_market_receptivity,
            actionability: s.actionability,
            confidence: s.confidence,
            briefing_rank: s.briefing_rank,
            score_class: s.score_class,
            cohort: s.cohort,
            signals: s.signals,
            scored_at: new Date().toISOString(),
        }));
        
        // Upsert in chunks of 500
        const chunkSize = 500;
        let written = 0;
        for (let i = 0; i < toWrite.length; i += chunkSize) {
            const chunk = toWrite.slice(i, i + chunkSize);
            const { error: upErr } = await supabase
                .from('parcel_scores')
                .upsert(chunk, { onConflict: 'parcel_id' });
            if (upErr) { console.error(`  Write error chunk ${i}: ${upErr.message}`); return; }
            written += chunk.length;
        }
        console.log(`  ✓ Wrote ${written} parcel_scores rows`);
    } else {
        console.log(`  (DRY RUN — no writes; use --write to persist)`);
    }
    
    console.log(`  Done in ${((Date.now() - startTs) / 1000).toFixed(1)}s`);
}

// ============================================================================
// Main
// ============================================================================
(async () => {
    const zips = getZipsToProcess();
    console.log(`Processing ${zips.length} ZIP(s)${opts.write ? ' [WRITE MODE]' : ' [DRY RUN]'}${opts.compare ? ' [COMPARE]' : ''}`);
    for (const zip of zips) {
        try {
            await processZip(zip);
        } catch (e) {
            console.error(`ZIP ${zip} failed: ${e.message}`);
            console.error(e.stack);
        }
    }
    console.log('\nDone.');
})();
