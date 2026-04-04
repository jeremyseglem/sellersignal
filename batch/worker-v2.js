// SellerSignal v2 Worker — Full-Universe Seller-State Inference
// Runs inference on ALL eligible parcels, not just a structural shortlist.

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { buildTruthObject, runInferenceBatch, computeRanking, isJunk } = require('./inference');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL_VERSION = 'seller_state_v1';
const BATCH_SIZE = 25; // parcels per API call
const CONCURRENCY = 2;  // parallel API calls

function log(msg) { console.log(`[${new Date().toISOString().substring(11,19)}] ${msg}`); }

async function loadParcels(zip) {
  const all = [];
  let offset = 0;
  const pageSize = 1000;
  
  while (true) {
    const { data, error } = await supabase
      .from('parcels')
      .select('*')
      .eq('zip_code', zip)
      .range(offset, offset + pageSize - 1);
    
    if (error) throw new Error(`Load parcels error: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  
  return all;
}

async function loadExistingInference(zip) {
  const all = [];
  let offset = 0;
  const pageSize = 1000;
  
  while (true) {
    const { data, error } = await supabase
      .from('seller_state_inference')
      .select('parcel_id, truth_hash')
      .eq('zip_code', zip)
      .range(offset, offset + pageSize - 1);
    
    if (error) break;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  
  return new Map(all.map(r => [r.parcel_id, r.truth_hash]));
}

async function processZip(zip, marketKey, marketContext) {
  log(`Processing ${zip}...`);
  
  // Load all parcels
  const parcels = await loadParcels(zip);
  log(`  ${parcels.length} parcels loaded`);
  
  // Filter junk (bouncer, not judge)
  const eligible = parcels.filter(p => !isJunk(p.owner_name));
  log(`  ${eligible.length} eligible (${parcels.length - eligible.length} junk removed)`);
  
  // Build truth objects for all eligible
  const truthObjects = eligible.map(p => buildTruthObject(p, marketContext));
  
  // Check existing inference — skip if truth hash unchanged
  const existing = await loadExistingInference(zip);
  const needsInference = truthObjects.filter(t => {
    const existingHash = existing.get(t.parcelId);
    return existingHash !== t._truthHash;
  });
  
  log(`  ${needsInference.length} need inference (${truthObjects.length - needsInference.length} cached)`);
  
  if (needsInference.length === 0) {
    log(`  Skipping — all cached`);
    return { parcels: parcels.length, eligible: eligible.length, inferred: 0, errors: 0 };
  }
  
  // Chunk limit — process max N parcels per run to avoid Railway timeout
  const CHUNK_LIMIT = parseInt(process.env.V2_CHUNK_LIMIT) || 2000;
  const toProcess = needsInference.slice(0, CHUNK_LIMIT);
  const remaining = needsInference.length - toProcess.length;
  if (remaining > 0) {
    log(`  Chunking: processing ${toProcess.length} of ${needsInference.length} (${remaining} deferred to next run)`);
  }
  
  // Batch inference
  const batches = [];
  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    batches.push(toProcess.slice(i, i + BATCH_SIZE));
  }
  
  log(`  ${batches.length} batches of ~${BATCH_SIZE}`);
  
  let totalInferred = 0;
  let totalErrors = 0;
  
  // Process batches with limited concurrency
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    
    const results = await Promise.allSettled(
      chunk.map(async (batch, idx) => {
        const batchNum = i + idx + 1;
        try {
          // Strip internal fields and compact before sending to AI
          const cleanBatch = batch.map(t => {
            const { _truthHash, ...clean } = t;
            // Remove null/empty fields to save tokens
            const compact = JSON.parse(JSON.stringify(clean, (k, v) => 
              v === null || v === '' || v === 0 || v === false || (Array.isArray(v) && v.length === 0) ? undefined : v
            ));
            return compact;
          });
          
          const inferences = await runInferenceBatch(anthropic, cleanBatch, marketKey, MODEL_VERSION);
          
          // Build rows for upsert
          const rows = [];
          for (const inf of inferences) {
            const truth = batch.find(t => t.parcelId === inf.parcelId);
            if (!truth) continue;
            
            const { briefingRank, actTier } = computeRanking(inf);
            
            rows.push({
              parcel_id: inf.parcelId,
              zip_code: zip,
              market_key: marketKey,
              model_version: MODEL_VERSION,
              ownership_archetype: inf.ownershipArchetype || 'unknown',
              seller_state: inf.sellerState || 'stable_hold',
              pressure_sources: inf.pressureSources || [],
              timeline_bucket: inf.timelineBucket || 'unclear',
              preferred_outreach: inf.preferredOutreach || 'watch_only',
              seller_intent_score: inf.sellerIntentScore || 0,
              off_market_receptivity: inf.offMarketReceptivity || 0,
              contactability: inf.contactability || 0,
              false_positive_risk: inf.falsePositiveRisk || 1,
              confidence: inf.confidence || 0,
              top_reason: inf.topReason || null,
              main_blocker: inf.mainBlocker || null,
              evidence_keys: inf.evidenceKeys || [],
              briefing_rank: briefingRank,
              act_tier: actTier,
              truth_hash: truth._truthHash,
              computed_at: new Date().toISOString(),
            });
          }
          
          // Upsert to Supabase
          if (rows.length > 0) {
            const { error: uErr } = await supabase
              .from('seller_state_inference')
              .upsert(rows, { onConflict: 'parcel_id' });
            
            if (uErr) {
              log(`    Batch ${batchNum}: upsert error — ${uErr.message}`);
              return { inferred: 0, errors: batch.length };
            }
          }
          
          return { inferred: rows.length, errors: batch.length - rows.length };
        } catch (e) {
          log(`    Batch ${batchNum}: API error — ${e.message}`);
          return { inferred: 0, errors: batch.length };
        }
      })
    );
    
    for (const r of results) {
      if (r.status === 'fulfilled') {
        totalInferred += r.value.inferred;
        totalErrors += r.value.errors;
      } else {
        totalErrors += BATCH_SIZE;
      }
    }
    
    log(`  Progress: ${totalInferred}/${needsInference.length} inferred, ${totalErrors} errors`);
  }
  
  // ========================================
  // LAYER 3: INVESTIGATION — run on act_today + outreach parcels
  // Checks cache first — only re-investigates if expired (30 days) or truth_hash changed
  // ========================================
  const skipInvestigation = process.argv.includes('--noinvest');
  
  if (!skipInvestigation && process.env.SERPAPI_KEY) {
    const { investigateParcel } = require('./investigate');
    
    // Pull act_today + outreach parcels for this ZIP
    const { data: topParcels } = await supabase
      .from('seller_state_inference')
      .select('parcel_id, truth_hash')
      .eq('zip_code', zip)
      .in('act_tier', ['act_today', 'outreach'])
      .order('briefing_rank', { ascending: false })
      .limit(200);
    
    if (topParcels && topParcels.length > 0) {
      const topIds = topParcels.map(p => p.parcel_id);
      const truthHashes = new Map(topParcels.map(p => [p.parcel_id, p.truth_hash]));
      
      // Check investigation cache — skip parcels with valid cache
      const { data: cachedInvestigations } = await supabase
        .from('investigation_cache')
        .select('parcel_id, truth_hash_at_investigation, expires_at')
        .in('parcel_id', topIds);
      
      const cacheMap = new Map((cachedInvestigations || []).map(c => [c.parcel_id, c]));
      const now = new Date();
      
      const needsInvestigation = topIds.filter(id => {
        const cached = cacheMap.get(id);
        if (!cached) return true; // never investigated
        if (new Date(cached.expires_at) < now) return true; // expired
        if (cached.truth_hash_at_investigation !== truthHashes.get(id)) return true; // data changed
        return false;
      });
      
      const skipped = topIds.length - needsInvestigation.length;
      log(`  Layer 3: ${topIds.length} top parcels — ${skipped} cached, ${needsInvestigation.length} need investigation`);
      
      const enhanced = [];
      let investigated = 0;
      
      if (needsInvestigation.length > 0) {
        // Get parcel details for investigation
        const { data: parcelDetails } = await supabase
          .from('parcels')
          .select('id, owner_name, address, city, state, zip_code, assessed_value, is_absentee, is_out_of_state, owner_state, mailing_state, tenure_years, prop_type')
          .in('id', needsInvestigation);
        
        for (const p of (parcelDetails || [])) {
          try {
            const result = await investigateParcel(p);
            investigated++;
            
            // Cache the result
            await supabase.from('investigation_cache').upsert({
              parcel_id: p.id,
              zip_code: zip,
              search_count: result.searchCount,
              signal_count: result.signals.length,
              signals: result.signals,
              enhanced_claims: result.enhancedClaims,
              summary: result.summary,
              raw_result_count: result.rawResultCount || 0,
              investigated_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              truth_hash_at_investigation: truthHashes.get(p.id) || null,
            }, { onConflict: 'parcel_id' });
            
            if (result.signals.length > 0) {
              enhanced.push({ parcel: p, investigation: result });
            }
            
            if (investigated % 10 === 0) {
              log(`    Investigated ${investigated}/${parcelDetails.length} — ${enhanced.length} with new signals`);
            }
          } catch (e) {
            log(`    Investigation error on ${p.id}: ${e.message}`);
          }
        }
        
        log(`  Layer 3: ${investigated} investigated, ${enhanced.length} have new signals`);
      } // end if (needsInvestigation.length > 0)
      
      // Load cached investigation results for parcels we skipped
      if (skipped > 0) {
        const cachedIds = topIds.filter(id => !needsInvestigation.includes(id));
        const { data: cachedResults } = await supabase
          .from('investigation_cache')
          .select('parcel_id, signals, enhanced_claims')
          .in('parcel_id', cachedIds)
          .gt('signal_count', 0);
        
        if (cachedResults) {
          const { data: cachedParcelDetails } = await supabase
            .from('parcels')
            .select('id, owner_name, address, city, state, zip_code, assessed_value, is_absentee, is_out_of_state, owner_state, mailing_state, tenure_years, prop_type')
            .in('id', cachedResults.map(c => c.parcel_id));
          
          const parcelMap = new Map((cachedParcelDetails || []).map(p => [p.id, p]));
          for (const c of cachedResults) {
            const p = parcelMap.get(c.parcel_id);
            if (p) enhanced.push({ parcel: p, investigation: { signals: c.signals, enhancedClaims: c.enhanced_claims } });
          }
          log(`  Layer 3: ${cachedResults.length} cached results included in re-scoring`);
        }
      }
      
      // Re-score parcels that got new investigation signals
      if (enhanced.length > 0) {
        log(`  Re-scoring ${enhanced.length} parcels with investigation data...`);
        
        // Build enhanced truth objects with investigation claims
        const reScoreBatches = [];
        for (let i = 0; i < enhanced.length; i += BATCH_SIZE) {
          reScoreBatches.push(enhanced.slice(i, i + BATCH_SIZE));
        }
        
        for (const batch of reScoreBatches) {
          const enhancedTruths = batch.map(({ parcel, investigation }) => {
            const truth = buildTruthObject(parcel, marketContext);
            // Merge investigation findings into claims
            if (investigation.enhancedClaims.listingSignals.length) {
              truth.claims.transitionSignals.push(...investigation.enhancedClaims.listingSignals);
            }
            if (investigation.enhancedClaims.lifeEventSignals.length) {
              truth.claims.transitionSignals.push(...investigation.enhancedClaims.lifeEventSignals);
            }
            if (investigation.enhancedClaims.identitySignals.length) {
              truth.claims.contactSignals.push(...investigation.enhancedClaims.identitySignals);
            }
            if (investigation.enhancedClaims.blockerSignals.length) {
              truth.claims.blockerSignals.push(...investigation.enhancedClaims.blockerSignals);
            }
            // Remove investigation gaps that are now filled
            if (investigation.summary.hasListingHistory) {
              truth.gaps = truth.gaps.filter(g => g !== 'no listing history');
            }
            if (investigation.summary.hasLinkedIn || investigation.summary.hasLifeEvent) {
              truth.gaps = truth.gaps.filter(g => g !== 'no life-event data');
            }
            // Boost confidence for investigated parcels
            truth.confidence.market = Math.min(0.9, (truth.confidence.market || 0.3) + 0.2);
            
            const { _truthHash, ...clean } = truth;
            const compact = JSON.parse(JSON.stringify(clean, (k, v) =>
              v === null || v === '' || v === 0 || v === false || (Array.isArray(v) && v.length === 0) ? undefined : v
            ));
            return { parcelId: truth.parcelId, _truthHash, compact };
          });
          
          try {
            const inferences = await runInferenceBatch(
              anthropic, 
              enhancedTruths.map(t => t.compact), 
              market.key, 
              MODEL_VERSION + '_investigated'
            );
            
            const rows = [];
            for (const inf of inferences) {
              const truth = enhancedTruths.find(t => t.parcelId === inf.parcelId);
              if (!truth) continue;
              const { briefingRank, actTier } = computeRanking(inf);
              
              rows.push({
                parcel_id: inf.parcelId,
                zip_code: zip,
                market_key: market.key,
                model_version: MODEL_VERSION + '_investigated',
                ownership_archetype: inf.ownershipArchetype || 'unknown',
                seller_state: inf.sellerState || 'stable_hold',
                pressure_sources: inf.pressureSources || [],
                timeline_bucket: inf.timelineBucket || 'unclear',
                preferred_outreach: inf.preferredOutreach || 'watch_only',
                seller_intent_score: inf.sellerIntentScore || 0,
                off_market_receptivity: inf.offMarketReceptivity || 0,
                contactability: inf.contactability || 0,
                false_positive_risk: inf.falsePositiveRisk || 1,
                confidence: inf.confidence || 0,
                top_reason: inf.topReason || null,
                main_blocker: inf.mainBlocker || null,
                evidence_keys: inf.evidenceKeys || [],
                briefing_rank: briefingRank,
                act_tier: actTier,
                truth_hash: truth._truthHash + '_inv',
                computed_at: new Date().toISOString(),
              });
            }
            
            if (rows.length > 0) {
              await supabase.from('seller_state_inference').upsert(rows, { onConflict: 'parcel_id' });
              log(`    Re-scored ${rows.length} parcels with investigation data`);
            }
          } catch (e) {
            log(`    Re-score batch error: ${e.message}`);
          }
        }
      }
    }
  } else if (skipInvestigation) {
    log(`  Layer 3: Skipped (--noinvest flag)`);
  } else {
    log(`  Layer 3: Skipped (no SERPAPI_KEY)`);
  }
  
  // Update zip_briefings with act_today / outreach counts from inference
  const { data: tierCounts } = await supabase
    .from('seller_state_inference')
    .select('act_tier')
    .eq('zip_code', zip);
  
  if (tierCounts) {
    const actToday = tierCounts.filter(r => r.act_tier === 'act_today').length;
    const outreach = tierCounts.filter(r => r.act_tier === 'outreach').length;
    const deepFirst = tierCounts.filter(r => r.act_tier === 'deep_signal_first').length;
    
    await supabase
      .from('zip_briefings')
      .update({
        act_today_count: actToday,
        outreach_queue_count: outreach,
        computed_at: new Date().toISOString(),
      })
      .eq('zip_code', zip);
    
    log(`  Tiers: ${actToday} act_today, ${outreach} outreach, ${deepFirst} deep_signal_first`);
  }
  
  log(`  DONE: ${totalInferred} inferred, ${totalErrors} errors`);
  return { parcels: parcels.length, eligible: eligible.length, inferred: totalInferred, errors: totalErrors, remaining: remaining || 0 };
}

// ========================================
// MAIN — run inference for all ZIPs or specific ZIP
// ========================================
async function main() {
  const args = process.argv.slice(2);
  const singleZip = args.find(a => /^\d{5}$/.test(a));
  const runAll = args.includes('--all');
  
  log('=== SellerSignal v2 Inference Worker ===');
  
  // Load market configs
  const MARKETS = require('./markets').MARKETS;
  
  // Build ZIP → market mapping
  const zipToMarket = {};
  for (const [key, market] of Object.entries(MARKETS)) {
    for (const zip of (market.zips || [])) {
      zipToMarket[zip] = { key: market.key, homeState: market.homeState };
    }
  }
  
  let zips;
  if (singleZip) {
    zips = [singleZip];
  } else if (runAll) {
    zips = Object.keys(zipToMarket);
  } else {
    log('Usage: node batch/worker-v2.js --all  OR  node batch/worker-v2.js 85253');
    process.exit(1);
  }
  
  log(`Processing ${zips.length} ZIPs`);
  
  let totalParcels = 0, totalInferred = 0, totalErrors = 0, totalRemaining = 0;
  
  for (const zip of zips) {
    const market = zipToMarket[zip] || { key: 'unknown', homeState: '' };
    
    const marketContext = {
      homeState: market.homeState,
      localTurnoverPercentile: null,
    };
    
    try {
      const result = await processZip(zip, market.key, marketContext);
      totalParcels += result.parcels;
      totalInferred += result.inferred;
      totalErrors += result.errors;
      totalRemaining += result.remaining || 0;
    } catch (e) {
      log(`  ERROR on ${zip}: ${e.message}`);
      totalErrors++;
    }
  }
  
  log(`\n=== DONE: ${zips.length} ZIPs | ${totalParcels.toLocaleString()} parcels | ${totalInferred.toLocaleString()} inferred | ${totalErrors} errors | ${totalRemaining} remaining ===`);
  
  // Exit code 2 = more work to do, triggers auto-restart
  if (totalRemaining > 0) {
    log(`Remaining work detected — exiting with code 2 for auto-restart`);
    process.exit(2);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
