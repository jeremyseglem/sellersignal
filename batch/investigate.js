// SellerSignal — Full Investigation Engine for Batch Pipeline
// Extracted from server.js deep signal investigation — 14-30 searches per parcel
// Tier 1 (core) + Tier 2 (gap-fill) + Tier 3 (enrichment) + entity resolution

const SERPAPI_KEY = process.env.SERPAPI_KEY;

async function searchGoogle(query) {
  if (!SERPAPI_KEY) return [];
  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}&num=5`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return [];
    return (data.organic_results || []).slice(0, 5).map(r => ({
      title: (r.title || '').substring(0, 200),
      snippet: (r.snippet || '').substring(0, 400),
      link: r.link
    }));
  } catch (e) { return []; }
}

async function searchBatch(queries) {
  const output = {};
  const batchSize = 8;
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map(async (q) => ({ label: q.label, results: await searchGoogle(q.query) }))
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') output[r.value.label] = r.value.results;
    }
    if (i + batchSize < queries.length) await new Promise(r => setTimeout(r, 300));
  }
  return output;
}

function normalizeOwnerName(rawName) {
  if (!rawName) return { full: '', searchPrimary: '', first: '', last: '', original: '', isEntity: false };
  let name = rawName.trim();
  if (!name) return { full: '', searchPrimary: '', first: '', last: '', original: '', isEntity: false };
  const cleanName = name.replace(/\s*&\s*.*$/, '').trim();
  const parts = cleanName.split(/\s+/);
  const biz = /LLC|TRUST|LTD|PARTNERSHIP|INC|CORP|ESTATE|FOUNDATION|HOLDINGS|COMPANY|GROUP|RANCH|FARM|PROPERTIES|INVESTMENTS|ASSOCIATES|VENTURES|ENTERPRISES|PARTNERS|DEVELOPMENT|REALTY|MANAGEMENT|CLUB|LAND|HOMES|BUILDERS|CAPITAL/i;
  if (biz.test(cleanName) || /\d/.test(cleanName)) return { full: name, searchPrimary: name, first: '', last: '', original: name, isEntity: true };
  if (parts.length < 2) return { full: name, searchPrimary: name, first: '', last: name, original: name, isEntity: false };
  if (parts.length > 3) return { full: name, searchPrimary: name, first: '', last: '', original: name, isEntity: true };
  const allAlpha = parts.every(p => /^[A-Za-z][A-Za-z.\-']*$/.test(p));
  if (!allAlpha) return { full: name, searchPrimary: name, first: '', last: '', original: name, isEntity: false };
  const tc = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  return { full: tc.length > 2 ? `${tc[1]} ${tc[2]} ${tc[0]}` : `${tc[1]} ${tc[0]}`, searchPrimary: `${tc[1]} ${tc[0]}`, first: tc[1], last: tc[0], original: name, isEntity: false };
}

async function investigateParcel(parcel) {
  const ownerName = parcel.owner_name || parcel.ownerName || '';
  const rawAddress = parcel.address || '';
  const city = parcel.city || parcel.situs_city || 'Bozeman';
  const state = parcel.state || parcel.situs_state || 'MT';
  const streetAddress = rawAddress.replace(/\s+(BOZEMAN|SCOTTSDALE|CHARLOTTE|SEATTLE|BELLEVUE|MIAMI|MT|AZ|NC|WA|FL|NY|OR|MONTANA|ARIZONA|\d{5}).*/i, '').trim();
  const n = normalizeOwnerName(ownerName);
  const searchName = n.searchPrimary || ownerName;
  const firstName = n.first; const lastName = n.last; const isEntity = n.isEntity;
  const allResults = {}; let totalSearches = 0;

  // TIER 1
  const tier1 = [
    { label: 'Zillow', query: `"${streetAddress}" "${city}" site:zillow.com` },
    { label: 'Redfin', query: `"${streetAddress}" "${city}" site:redfin.com` },
    { label: 'Realtor.com', query: `"${streetAddress}" "${city}" site:realtor.com` },
    { label: 'County Tax', query: `"${streetAddress}" "${city}" ${state} tax assessor property` },
    { label: 'Broad Identity', query: `${searchName} ${city}` },
    { label: 'Owner+City+State', query: `"${searchName}" "${city}" ${state}` },
    { label: 'FastPeopleSearch', query: `"${searchName}" "${city}" site:fastpeoplesearch.com` },
    { label: 'LinkedIn', query: `"${searchName}" ${city} ${state} site:linkedin.com` },
    { label: 'RE Agent General', query: `"${searchName}" "${city}" realtor OR "real estate agent" OR broker` },
    { label: 'Life Events', query: `"${searchName}" "${city}" ${state} retired OR retirement OR divorce OR obituary` },
    { label: 'News', query: `"${searchName}" "${city}" ${state} news OR article` },
  ];
  if (isEntity) {
    const eName = ownerName.trim(); const st = state.trim().toUpperCase();
    tier1.push(
      { label: 'SOS Registered Agent', query: `"${eName}" ${st} registered agent secretary of state` },
      { label: 'Entity Members', query: `"${eName}" ${st} member OR manager OR officer OR principal` },
      { label: 'Entity OpenCorporates', query: `"${eName}" ${st} site:opencorporates.com` }
    );
  }
  const t1 = await searchBatch(tier1); Object.assign(allResults, t1); totalSearches += tier1.length;

  // TIER 2
  const tier2 = [];
  if (!(t1['Zillow']?.length) && !(t1['Redfin']?.length)) {
    tier2.push({ label: 'Trulia', query: `"${streetAddress}" "${city}" site:trulia.com` });
    tier2.push({ label: 'Property History', query: `"${streetAddress}" "${city}" sold sale listing history` });
  }
  if (!(t1['LinkedIn']?.length) && !isEntity) {
    tier2.push({ label: 'LinkedIn Alt', query: `"${firstName} ${lastName}" ${state} site:linkedin.com` });
    tier2.push({ label: 'Professional Profile', query: `"${searchName}" "${city}" ${state} professional OR career OR work` });
  }
  if (!(t1['FastPeopleSearch']?.length) && !isEntity) {
    tier2.push({ label: 'WhitePages', query: `"${searchName}" "${city}" ${state} site:whitepages.com` });
    tier2.push({ label: 'Spokeo', query: `"${searchName}" "${city}" site:spokeo.com` });
  }
  if (!(t1['Owner+City+State']?.length)) tier2.push({ label: 'Owner at Address', query: `"${searchName}" "${streetAddress}"` });
  if (t1['RE Agent General']?.length > 0) tier2.push({ label: 'Zillow Agent', query: `"${searchName}" ${city} ${state} site:zillow.com/profile` });
  tier2.push({ label: 'Business Owner', query: `"${searchName}" "${city}" business owner` });
  if (isEntity && !(t1['SOS Registered Agent']?.length)) {
    tier2.push({ label: 'SOS Business Filing', query: `"${ownerName.trim()}" ${state.trim().toUpperCase()} business entity filing` });
  }
  if (tier2.length > 0) { const t2 = await searchBatch(tier2); Object.assign(allResults, t2); totalSearches += tier2.length; }

  // TIER 3 (if thin)
  const itemsSoFar = Object.values(allResults).reduce((s, r) => s + r.length, 0);
  if (itemsSoFar < 25 && !isEntity) {
    const tier3 = [
      { label: 'Facebook', query: `"${searchName}" "${city}" ${state} site:facebook.com` },
      { label: 'Family', query: `"${searchName}" "${city}" spouse OR wife OR husband OR family` },
      { label: 'Community', query: `"${searchName}" "${city}" ${state} board OR volunteer OR foundation` },
      { label: 'Court Records', query: `"${searchName}" "${city}" ${state} court OR filing OR lien` },
      { label: 'Age Records', query: `"${searchName}" "${city}" age OR born OR birthday` },
      { label: 'Relocation', query: `"${searchName}" "moving" OR "relocated" OR "downsizing"` },
    ];
    const t3 = await searchBatch(tier3); Object.assign(allResults, t3); totalSearches += tier3.length;
  }

  // EXTRACT SIGNALS
  const signals = extractAllSignals(allResults);
  return {
    parcelId: parcel.id || parcel.parcel_id,
    searchCount: totalSearches,
    signals,
    summary: {
      hasListingHistory: signals.some(s => s.category === 'listing'),
      hasPreviousListing: signals.some(s => s.type === 'previously_listed' || s.type === 'price_history'),
      hasLifeEvent: signals.some(s => s.category === 'life_event'),
      isAgent: signals.some(s => s.type === 'is_agent'),
      hasLinkedIn: signals.some(s => s.type === 'linkedin_found'),
      hasAge: signals.some(s => s.type === 'age_found'),
      isPending: signals.some(s => s.type === 'pending_sale'),
      signalCount: signals.length, searchCount: totalSearches,
    },
    enhancedClaims: {
      listingSignals: signals.filter(s => s.category === 'listing').map(s => s.detail),
      lifeEventSignals: signals.filter(s => s.category === 'life_event').map(s => s.detail),
      identitySignals: signals.filter(s => s.category === 'identity').map(s => s.detail),
      demographicSignals: signals.filter(s => s.category === 'demographic').map(s => s.detail),
      financialSignals: signals.filter(s => s.category === 'financial').map(s => s.detail),
      blockerSignals: signals.filter(s => s.category === 'blocker').map(s => s.detail),
    },
    rawResultCount: Object.values(allResults).reduce((s, r) => s + r.length, 0),
  };
}

function extractAllSignals(allResults) {
  const signals = [];
  // LISTING
  for (const label of ['Zillow','Redfin','Realtor.com','Trulia','Property History']) {
    const res = allResults[label]; if (!res?.length) continue;
    const t = res.map(r => `${r.title} ${r.snippet}`).join(' '); const lo = t.toLowerCase();
    if (/off\s*market|removed|delisted|withdrawn|expired|cancelled|previously listed/i.test(lo))
      signals.push({ type:'previously_listed', category:'listing', confidence:0.85, detail:'Property was listed but is now off market' });
    if (/pending|under contract|contingent/i.test(lo) && !/was pending|previously|no longer/i.test(lo))
      signals.push({ type:'pending_sale', category:'blocker', confidence:0.7, detail:'Possibly pending sale' });
    if (/price (cut|drop|reduced|change)|reduced by/i.test(lo))
      signals.push({ type:'price_history', category:'listing', confidence:0.75, detail:'Price reductions in history — motivated seller' });
    if (/(\d{3,})\s*days?\s*(on|listed)/i.test(lo))
      signals.push({ type:'extended_dom', category:'listing', confidence:0.8, detail:'Extended days on market' });
    if (res.some(r => /zillow|redfin|realtor|trulia/.test(r.link||'')))
      signals.push({ type:'listing_history_exists', category:'listing', confidence:0.4, detail:'Has listing platform history' });
    // Historical price extraction — filter aggressively to avoid per-sqft,
    // rental rates, HOA dues, and other numbers that look like prices but
    // aren't total listing prices. The bug that motivated this: Bel Sogno
    // Estate LLC motivation read "previously listed at $10,454" because the
    // raw snippet contained "$10,454/sqft" or similar. Filter rules:
    //   - Must be >= $50,000 (nothing legit lists under this)
    //   - Must NOT be followed by /sqft, per square foot, /mo, per month, /yr
    //   - Must NOT be immediately preceded by "hoa", "fee", "tax", "rent"
    //   - Take the LARGEST plausible match (listing prices dominate snippets)
    const priceMatches = [...lo.matchAll(/\$([\d,]+)(?:\s*([\/\-\w\s]{0,20}))?/g)];
    const plausiblePrices = [];
    for (const pm of priceMatches) {
      const raw = pm[1];
      const trailing = (pm[2] || '').slice(0, 20);
      const n = parseInt(raw.replace(/,/g, ''), 10);
      if (!Number.isFinite(n) || n < 50000) continue;
      // Reject per-sqft / rental / monthly / HOA context
      if (/\/?\s*(sq\s*ft|sqft|sf|month|mo|yr|year|week|wk|day|night)/i.test(trailing)) continue;
      // Reject HOA/fee/rent context immediately before the price
      const idx = pm.index || 0;
      const before = lo.slice(Math.max(0, idx - 20), idx);
      if (/(hoa|fee|dues|tax(es)?|rent(al)?|per\s+month)\s*[:=]?\s*$/i.test(before)) continue;
      plausiblePrices.push(n);
    }
    if (plausiblePrices.length > 0) {
      const largest = Math.max(...plausiblePrices);
      signals.push({ type:'historical_price', category:'listing', confidence:0.5, detail:'$' + largest.toLocaleString() });
    }
  }
  // LINKEDIN / PROFESSIONAL
  for (const label of ['LinkedIn','LinkedIn Alt']) {
    const res = allResults[label]; if (!res?.length) continue;
    const t = res.map(r => `${r.title} ${r.snippet}`).join(' ');
    if (res.some(r => /linkedin\.com\/in\//.test(r.link||'')))
      signals.push({ type:'linkedin_found', category:'identity', confidence:0.7, detail:res[0].title });
    if (/retired|retirement|former\s+(ceo|president|director|vp|partner|owner)/i.test(t))
      signals.push({ type:'retired', category:'life_event', confidence:0.7, detail:'Retirement indicator from LinkedIn' });
    if (/relocated|moved to|new position in/i.test(t))
      signals.push({ type:'relocation', category:'life_event', confidence:0.7, detail:'Relocation indicator' });
  }
  for (const label of ['Professional Profile','Business Owner','Broad Identity']) {
    const res = allResults[label]; if (!res?.length) continue;
    const t = res.map(r => `${r.title} ${r.snippet}`).join(' ');
    if (/ceo|president|founder|owner|managing|director|partner/i.test(t) && !signals.some(s => s.type==='business_owner'))
      signals.push({ type:'business_owner', category:'identity', confidence:0.6, detail:'Business owner/executive' });
  }
  // DEMOGRAPHICS
  for (const label of ['FastPeopleSearch','WhitePages','Spokeo','Age Records']) {
    const res = allResults[label]; if (!res?.length) continue;
    const t = res.map(r => `${r.title} ${r.snippet}`).join(' ');
    const am = t.match(/age\s*(\d{2,3})|(\d{2,3})\s*years?\s*old|born\s*(?:in\s*)?(19\d{2})/i);
    if (am) {
      const age = am[1] || am[2] || (am[3] ? (new Date().getFullYear()-parseInt(am[3])) : null);
      if (age && parseInt(age) > 20 && parseInt(age) < 110)
        signals.push({ type:'age_found', category:'demographic', confidence:0.6, detail:`Estimated age: ${age}` });
    }
    if (/spouse|wife|husband|married/i.test(t))
      signals.push({ type:'spouse_found', category:'demographic', confidence:0.5, detail:'Spouse/partner found' });
  }
  // LIFE EVENTS
  for (const label of ['Life Events','Family','News','Relocation']) {
    const res = allResults[label]; if (!res?.length) continue;
    const t = res.map(r => `${r.title} ${r.snippet}`).join(' ');
    if (/obituary|passed away|in loving memory|memorial|funeral/i.test(t) && !signals.some(s => s.type==='obituary'))
      signals.push({ type:'obituary', category:'life_event', confidence:0.75, detail:'Possible death in household' });
    if (/divorce|dissolution of marriage/i.test(t) && !signals.some(s => s.type==='divorce'))
      signals.push({ type:'divorce', category:'life_event', confidence:0.7, detail:'Divorce indicator' });
    if (/retired|retirement/i.test(t) && !signals.some(s => s.type==='retired'))
      signals.push({ type:'retirement', category:'life_event', confidence:0.65, detail:'Retirement indicator' });
    if (/bankrupt|foreclosure|tax\s*lien|delinquent/i.test(t))
      signals.push({ type:'financial_distress', category:'financial', confidence:0.8, detail:'Financial distress' });
    if (/relocated|moving|moved|downsiz/i.test(t) && !signals.some(s => s.type==='relocation'))
      signals.push({ type:'relocation', category:'life_event', confidence:0.65, detail:'Relocation/downsizing indicator' });
  }
  // COURT
  const cr = allResults['Court Records']; if (cr?.length) {
    const t = cr.map(r=>`${r.title} ${r.snippet}`).join(' ').toLowerCase();
    if (/lien|judgment|foreclosure/i.test(t)) signals.push({ type:'legal_encumbrance', category:'financial', confidence:0.7, detail:'Legal encumbrance' });
    if (/probate|estate\s*filing|executor/i.test(t)) signals.push({ type:'probate', category:'life_event', confidence:0.8, detail:'Probate/estate filing' });
  }
  // AGENT (blocker)
  const ag = allResults['RE Agent General']; if (ag?.length) {
    const za = allResults['Zillow Agent'];
    if (za?.length && za.some(r => /zillow\.com\/profile/i.test(r.link||'')))
      signals.push({ type:'is_agent', category:'blocker', confidence:0.85, detail:'Owner is a real estate agent' });
    else if (/licensed\s*(real estate|realtor|broker)/i.test(ag.map(r=>`${r.title} ${r.snippet}`).join(' ')))
      signals.push({ type:'is_agent', category:'blocker', confidence:0.7, detail:'Owner may be a licensed agent' });
  }
  // ENTITY
  for (const label of ['SOS Registered Agent','Entity Members','SOS Business Filing','Entity OpenCorporates']) {
    const res = allResults[label]; if (!res?.length) continue;
    signals.push({ type:'entity_info', category:'identity', confidence:0.6, detail:`Entity info: ${res.map(r=>r.title).join('; ').substring(0,200)}` });
  }
  // COMMUNITY
  for (const label of ['Community','Facebook']) {
    const res = allResults[label]; if (!res?.length) continue;
    if (/board|trustee|director|chairman|foundation/i.test(res.map(r=>`${r.title} ${r.snippet}`).join(' ')))
      signals.push({ type:'community_leader', category:'demographic', confidence:0.5, detail:'Community leadership' });
  }
  // Dedupe
  const seen = new Set();
  return signals.filter(s => { const k = s.type+':'+s.category; if (seen.has(k)) return false; seen.add(k); return true; });
}

module.exports = { investigateParcel, searchGoogle, searchBatch, normalizeOwnerName, extractAllSignals };
