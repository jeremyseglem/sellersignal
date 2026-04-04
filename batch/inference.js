// SellerSignal v2 — Full-Universe Seller-State Inference Engine
// Runs on ALL parcels. Structured truth → AI reasoning → persisted scores.

const crypto = require('crypto');

// ========================================
// SYSTEM PROMPT — the model contract
// ========================================
const SYSTEM_PROMPT = `You are the Seller-State Inference layer for SellerSignal.

You are NOT writing a narrative dossier.
You are NOT performing web research.
You are NOT inventing biographical details.
You are NOT deciding based on vibes.

You will receive structured truth objects for many parcels.
For each parcel, infer a likely seller state from the evidence provided.

Your job for each parcel:
1. Classify the ownership archetype
2. Infer the most plausible seller state
3. Identify actual pressure sources visible in the data
4. Estimate a timeline bucket
5. Recommend the best outreach mode
6. Produce bounded numeric scores from 0 to 1:
   - sellerIntentScore
   - offMarketReceptivity
   - contactability
   - falsePositiveRisk
   - confidence
7. Return a short topReason and mainBlocker
8. Return evidenceKeys that justify the decision

Rules:
- Do not invent facts not present in the truth object
- Do not assume retirement, grief, divorce, relocation, or distress without evidence
- Treat missing tenure as a meaningful confidence reduction
- Trust/LLC/entity structure alone is NOT enough for high seller intent
- Vacant land alone is NOT enough for high seller intent
- Long tenure + distance + underuse + market timing + strong contact path together can raise seller intent
- If evidence is thin or conflicting, lower confidence and increase falsePositiveRisk
- If blockers are present, reflect them explicitly
- Be conservative
- Use only the allowed enum values
- Return strict JSON only — no markdown, no backticks, no commentary
- Return one result for every input parcel`;

// ========================================
// TRUTH OBJECT BUILDER — from raw parcel data
// ========================================
function buildTruthObject(parcel, marketContext) {
  const p = parcel;
  const on = (p.owner_name || p.ownerName || '').toUpperCase();
  
  // Owner type detection
  let ownerType = 'individual';
  if (/\bTRUST\b|\bTRSTEE\b|\bTRUSTEE\b|\bLIVING\s*TR\b|\bFAMILY\s*TR\b/.test(on)) ownerType = 'trust';
  else if (/\bESTATE\b|\bHEIRS\b|\bDECEASED\b|\bSURVIVOR\b/.test(on)) ownerType = 'estate';
  else if (/\bLLC\b|\bINC\b|\bCORP\b|\bLTD\b|\bPARTNERS\b|\bHOLDINGS\b|\bGROUP\b|\bENTERPRISE\b/.test(on)) ownerType = 'llc';
  
  // Portfolio detection
  const portfolioSize = p.multi_count || 1;
  const portfolioClass = portfolioSize >= 10 ? 'large' : portfolioSize >= 3 ? 'medium' : portfolioSize >= 2 ? 'small' : 'single';
  
  // Tenure
  const tenureYears = p.tenure_years ?? (p.last_transfer_date ? Math.round((Date.now() - new Date(p.last_transfer_date).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : null);
  const tenureBucket = tenureYears == null ? 'unknown' : tenureYears < 3 ? 'recent_buyer' : tenureYears < 10 ? '3_to_10' : '10_plus';
  
  // Occupancy inference
  const isAbsentee = p.is_absentee ?? false;
  const isOutOfState = p.is_out_of_state ?? false;
  const likelyOccupancy = isOutOfState ? 'seasonal' : isAbsentee ? 'non_owner_occupied' : 'owner_occupied';
  
  // Mailing path quality
  const hasMailing = !!(p.mailing_address || p.mailing_city);
  const mailPathQuality = hasMailing && (p.mailing_state || p.owner_state) ? 'strong' : hasMailing ? 'usable' : 'none';
  
  // Value
  const assessedValue = p.assessed_value ?? p.totalValue ?? 0;
  const buildingValue = p.building_value ?? p.buildingValue ?? 0;
  const landValue = p.land_value ?? p.landValue ?? 0;
  const hasBuildingValue = buildingValue > 0;
  const isVacantLand = p.is_vacant_land ?? (!hasBuildingValue && landValue > 0);
  
  // Claims / signals
  const claims = {
    timeSignals: [],
    transitionSignals: [],
    burdenSignals: [],
    contactSignals: [],
    marketSignals: [],
    blockerSignals: []
  };
  
  if (tenureYears != null && tenureYears >= 15) claims.timeSignals.push(`${tenureYears}-year ownership`);
  if (tenureYears != null && tenureYears >= 25) claims.timeSignals.push('long-term holder (25+ years)');
  if (ownerType === 'estate') claims.transitionSignals.push('estate/heir ownership — possible forced disposition');
  if (ownerType === 'trust' && tenureYears != null && tenureYears >= 20) claims.transitionSignals.push('aging trust — possible succession transition');
  if (isOutOfState) claims.burdenSignals.push('out-of-state owner — distance burden');
  if (isAbsentee && !isOutOfState) claims.burdenSignals.push('absentee owner — possible rental or secondary residence');
  if (isAbsentee && isOutOfState) claims.burdenSignals.push('remote absentee — high management burden');
  if (portfolioSize >= 3) claims.burdenSignals.push(`portfolio of ${portfolioSize} properties — simplification pressure`);
  if (isVacantLand && assessedValue > 0) claims.burdenSignals.push('vacant land — carrying cost with no income');
  if (on.length > 3 && !/^[\d]/.test(on)) claims.contactSignals.push('named owner');
  if (mailPathQuality !== 'none') claims.contactSignals.push(`${mailPathQuality} mailing path`);
  if (p.address || p.situs_address) claims.contactSignals.push('known situs address');
  
  // Gaps
  const gaps = [];
  if (tenureYears == null) gaps.push('no tenure/transfer data');
  if (assessedValue === 0) gaps.push('no assessed value');
  if (!hasMailing) gaps.push('no mailing address');
  if (mailPathQuality === 'none') gaps.push('no verified contact path');
  gaps.push('no life-event data');
  gaps.push('no listing history');
  
  // Confidence per dimension
  const confidence = {
    ownership: on.length > 3 ? 0.9 : 0.3,
    tenure: tenureYears != null ? 0.8 : 0.2,
    contact: mailPathQuality === 'strong' ? 0.8 : mailPathQuality === 'usable' ? 0.5 : 0.1,
    market: marketContext?.localTurnoverPercentile != null ? 0.6 : 0.3
  };
  
  const truthObject = {
    parcelId: p.id || p.parcel_id,
    market: {
      state: p.state || p.situs_state || marketContext?.homeState || '',
      zip: p.zip_code || p.situs_zip || '',
      city: p.city || p.situs_city || '',
    },
    property: {
      propertyType: (p.prop_type || 'residential').toLowerCase(),
      isVacantLand,
      hasBuildingValue,
      assessedValue,
      landValue,
      buildingValue,
      acreage: p.acres || p.acreage || 0,
    },
    ownership: {
      ownerNameRaw: p.owner_name || p.ownerName || '',
      ownerType,
      mailingMismatch: isAbsentee || isOutOfState,
      isAbsentee,
      isOutOfState,
      ownerState: p.owner_state || p.mailing_state || '',
      portfolioSize,
      portfolioClass,
    },
    tenure: {
      tenureYears,
      recentTransferBucket: tenureBucket,
      tenureConfidence: confidence.tenure,
    },
    occupancy: {
      likelyOccupancy,
      mailPathQuality,
    },
    marketContext: {
      localTurnoverPercentile: marketContext?.localTurnoverPercentile ?? null,
    },
    claims,
    gaps,
    confidence,
  };
  
  // Compute truth hash for cache invalidation
  const hashInput = JSON.stringify({
    owner: on,
    absentee: isAbsentee,
    oos: isOutOfState,
    val: assessedValue,
    tenure: tenureYears,
    type: ownerType,
    mailing: p.mailing_state || p.owner_state || '',
  });
  truthObject._truthHash = crypto.createHash('md5').update(hashInput).digest('hex');
  
  return truthObject;
}

// ========================================
// BATCH INFERENCE — send truth objects to Claude
// ========================================
async function runInferenceBatch(anthropic, truthObjects, marketKey, modelVersion) {
  const userPrompt = `Score ${truthObjects.length} parcels. Market: ${marketKey}. Model: ${modelVersion}.

Return ONLY raw JSON (no markdown, no backticks):
{"results":[{"parcelId":"str","ownershipArchetype":"owner_occupant_long_term|individual_absentee_second_home|trust_estate_transition|small_portfolio_simplifier|vacant_land_holder|ranch_operator|institutional_entity|unknown","sellerState":"stable_hold|latent_transition|moderate_motivation|high_motivation|research_required|likely_false_positive","pressureSources":["str"],"timelineBucket":"0_6_months|6_12_months|12_24_months|24_plus_months|unclear","preferredOutreach":"soft_mail|call_first|research_first|watch_only|premium_discreet_outreach","sellerIntentScore":0.0,"offMarketReceptivity":0.0,"contactability":0.0,"falsePositiveRisk":0.0,"confidence":0.0,"topReason":"str","mainBlocker":"str","evidenceKeys":["str"]}]}

Parcels:
${JSON.stringify(truthObjects)}`;

  const response = await anthropic.messages.create({
    model: process.env.ANTHROPIC_BATCH_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 16000,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: '{"results":[' }
    ]
  });
  
  let rawText = '{"results":[' + (response.content
    ?.filter(c => c.type === 'text')
    ?.map(c => c.text)
    ?.join('\n')
    ?.trim() || '');
  
  // Strip markdown fences
  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  
  // Parse JSON
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
    }
  }
  
  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error('Model returned invalid JSON: ' + rawText.substring(0, 200));
  }
  
  return parsed.results;
}

// ========================================
// COMPUTE RANKING from inference results
// ========================================
function computeRanking(inference) {
  const rank = 
    0.45 * (inference.sellerIntentScore || inference.seller_intent_score || 0) +
    0.20 * (inference.offMarketReceptivity || inference.off_market_receptivity || 0) +
    0.20 * (inference.contactability || 0) +
    0.15 * (inference.confidence || 0) -
    0.25 * (inference.falsePositiveRisk || inference.false_positive_risk || 0);
  
  const si = inference.sellerIntentScore || inference.seller_intent_score || 0;
  const ct = inference.contactability || 0;
  const fp = inference.falsePositiveRisk || inference.false_positive_risk || 0;
  const conf = inference.confidence || 0;
  
  let tier = 'watch';
  if (si >= 0.62 && ct >= 0.55 && fp <= 0.30 && conf >= 0.50) tier = 'act_today';
  else if (si >= 0.48 && ct >= 0.45 && fp <= 0.40) tier = 'outreach';
  else if (si >= 0.38) tier = 'deep_signal_first';
  
  return { briefingRank: Math.round(rank * 100) / 100, actTier: tier };
}

// ========================================
// INSTITUTIONAL FILTER — bouncer, not judge
// ========================================
const JUNK_RX = /\bUSA\b|\bCITY OF\b|\bTOWN OF\b|\bVILLAGE OF\b|\bBOROUGH OF\b|\bCOUNTY OF\b|\bSTATE OF\b|\bUNITED STATES\b|\bFEDERAL\b|\bMUNICIPAL\b|\bSCHOOL\b|\bACADEMY\b|\bSEMINARY\b|\bFIRE DIST|\bWATER DIST|\bSEWER\b|\bHOUSING AUTH|\bCHURCH\b|\bDIOCESE\b|\bMINISTR(Y|IES)\b|\bPARISH\b|\bMONASTER|\bCONVENT\b|\bSYNAGOGUE\b|\bTEMPLE\b|\bMOSQUE\b|\bHOA\b|\bHOMEOWNERS?\s*ASS|\bCONDO\s*(MASTER|ASSOC)|\bCONDOMINIUM\s*ASS|\bOWNERS?\s*ASSOC|\bMASTER\s*ASSOC|\bCOMMUNITY\s*ASSOC|\bMUSEUM\b|\bCEMETERY\b|\bLIBRARY\b|\bFOUNDATION\b|\bUNIVERSIT(Y|IES)\b|\bCOLLEGE\b|\bHOSPITAL\b|\bHEALTH(CARE)?\s*(SYSTEM|INC|CORP|GROUP|CENTER)\b|\bMEDICAL\s*CENTER\b|\bYMCA\b|\bYWCA\b|\bROTARY\b|\bLIONS\s*CLUB|\bELKS\b|\bVFW\b|\bAMERICAN\s*LEGION|\bSALVATION\s*ARMY|\bGOODWILL\b|\bHABITAT\b|\bRED\s*CROSS|\bBANK\b|\bCREDIT\s*UNION|\bMORTGAGE\b|\bLENDING\b|\bREAL ESTATE\b|\bREALTY\b|\bBROKERAGE\b/i;

function isJunk(ownerName) {
  if (!ownerName || ownerName.length < 3) return false; // blank names are NOT junk — real properties, unknown owner
  return JUNK_RX.test(ownerName);
}

module.exports = {
  buildTruthObject,
  runInferenceBatch,
  computeRanking,
  isJunk,
  SYSTEM_PROMPT,
};
