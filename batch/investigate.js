// SellerSignal — Batch Investigation Module
// Runs targeted web searches on top-tier parcels to find listing history,
// employment, life events, and other signals invisible in GIS data.
// 3-5 searches per parcel. Results feed back into inference for re-scoring.

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
      snippet: (r.snippet || '').substring(0, 300),
      link: r.link
    }));
  } catch { return []; }
}

// Normalize "SMITH JOHN A" → "John Smith"
function normalizeName(raw) {
  if (!raw) return { search: '', first: '', last: '', isEntity: false };
  const up = raw.toUpperCase().trim();
  const isEntity = /LLC|TRUST|LTD|PARTNERSHIP|INC|CORP|ESTATE|FOUNDATION|HOLDINGS|COMPANY|GROUP/i.test(up);
  if (isEntity) return { search: raw.trim(), first: '', last: '', isEntity: true };
  
  const parts = up.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
  if (parts.length < 2) return { search: raw.trim(), first: '', last: parts[0] || '', isEntity: false };
  
  // LAST FIRST MIDDLE format
  const last = parts[0];
  const first = parts[1];
  const searchName = first.charAt(0) + first.slice(1).toLowerCase() + ' ' + last.charAt(0) + last.slice(1).toLowerCase();
  return { search: searchName, first: first.charAt(0) + first.slice(1).toLowerCase(), last: last.charAt(0) + last.slice(1).toLowerCase(), isEntity };
}

// Extract signals from search results
function extractSignals(label, results) {
  const signals = [];
  if (!results || results.length === 0) return signals;
  
  const allText = results.map(r => `${r.title} ${r.snippet}`).join(' ').toLowerCase();
  
  if (label === 'Zillow' || label === 'Redfin' || label === 'Listing') {
    if (/for sale|active listing|listed for/i.test(allText)) signals.push({ type: 'active_listing', confidence: 0.9, detail: 'Active listing found' });
    if (/sold|closed|off market.*sold/i.test(allText)) signals.push({ type: 'recently_sold', confidence: 0.8, detail: 'Recent sale detected' });
    if (/pending|under contract/i.test(allText)) signals.push({ type: 'pending_sale', confidence: 0.85, detail: 'Pending sale' });
    if (/price (cut|drop|reduced|change)|reduced by/i.test(allText)) signals.push({ type: 'price_reduction', confidence: 0.8, detail: 'Price reduction detected' });
    if (/off market|removed|delisted|withdrawn|expired|cancelled/i.test(allText)) signals.push({ type: 'failed_listing', confidence: 0.75, detail: 'Previous listing failed/expired' });
    if (/days on (market|zillow|redfin)|dom\b/i.test(allText)) signals.push({ type: 'extended_dom', confidence: 0.6, detail: 'Extended days on market' });
    
    // Price extraction
    const priceMatch = allText.match(/\$[\d,]+(?:\.\d+)?(?:\s*(?:k|m))?/i);
    if (priceMatch) signals.push({ type: 'list_price', confidence: 0.7, detail: priceMatch[0] });
    
    // Multiple listing attempts
    const historyMatch = allText.match(/(\d+)\s*(?:times?|listing|sale)/i);
    if (historyMatch) signals.push({ type: 'multiple_listings', confidence: 0.7, detail: `${historyMatch[1]} listing attempts` });
  }
  
  if (label === 'LinkedIn') {
    if (results.length > 0) signals.push({ type: 'linkedin_found', confidence: 0.6, detail: results[0].title });
    if (/retired|retirement|former|ex-/i.test(allText)) signals.push({ type: 'retired', confidence: 0.7, detail: 'Retirement indicator' });
    if (/relocated|moving|moved to/i.test(allText)) signals.push({ type: 'relocation', confidence: 0.7, detail: 'Relocation indicator' });
  }
  
  if (label === 'Life Events') {
    if (/obituary|death|memorial|funeral|passed away|in loving memory/i.test(allText)) signals.push({ type: 'obituary', confidence: 0.8, detail: 'Possible death in household' });
    if (/divorce|dissolution|separated/i.test(allText)) signals.push({ type: 'divorce', confidence: 0.7, detail: 'Divorce indicator' });
    if (/retired|retirement/i.test(allText)) signals.push({ type: 'retirement', confidence: 0.7, detail: 'Retirement indicator' });
    if (/bankrupt|foreclosure|delinquent/i.test(allText)) signals.push({ type: 'financial_distress', confidence: 0.8, detail: 'Financial distress indicator' });
  }
  
  if (label === 'Agent Check') {
    if (/real estate agent|realtor|broker|realty/i.test(allText) && results.length > 0) {
      signals.push({ type: 'is_agent', confidence: 0.8, detail: 'Owner appears to be a real estate agent' });
    }
  }
  
  return signals;
}

// Run investigation on a single parcel
async function investigateParcel(parcel) {
  const ownerName = parcel.owner_name || parcel.ownerName || '';
  const address = parcel.address || '';
  const city = parcel.city || 'Bozeman';
  const state = parcel.state || 'MT';
  
  const norm = normalizeName(ownerName);
  const streetAddress = address.replace(/\s+(BOZEMAN|MT|MONTANA|\d{5}).*/i, '').trim();
  
  // Build targeted search plan — 3-5 searches max
  const searches = [
    { label: 'Zillow', query: `"${streetAddress}" "${city}" site:zillow.com` },
    { label: 'Listing', query: `"${streetAddress}" "${city}" ${state} for sale OR sold OR listing OR price` },
  ];
  
  if (!norm.isEntity) {
    searches.push({ label: 'LinkedIn', query: `"${norm.search}" "${city}" ${state} site:linkedin.com` });
    searches.push({ label: 'Life Events', query: `"${norm.search}" "${city}" ${state} retired OR retirement OR obituary OR divorce` });
  } else {
    searches.push({ label: 'Agent Check', query: `"${ownerName}" ${state} real estate agent OR realtor OR broker` });
    searches.push({ label: 'Life Events', query: `"${ownerName}" ${city} ${state} dissolved OR closed OR bankruptcy OR sold` });
  }
  
  // Execute searches with rate limiting
  const allSignals = [];
  const rawResults = {};
  let searchCount = 0;
  
  for (const s of searches) {
    const results = await searchGoogle(s.query);
    rawResults[s.label] = results;
    searchCount++;
    
    const signals = extractSignals(s.label, results);
    allSignals.push(...signals);
    
    // Brief pause to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Build investigation summary
  const hasListingHistory = allSignals.some(s => ['active_listing','failed_listing','recently_sold','pending_sale','price_reduction','extended_dom','multiple_listings'].includes(s.type));
  const hasLifeEvent = allSignals.some(s => ['obituary','divorce','retirement','financial_distress','relocation'].includes(s.type));
  const isAgent = allSignals.some(s => s.type === 'is_agent');
  const hasLinkedIn = allSignals.some(s => s.type === 'linkedin_found');
  
  return {
    parcelId: parcel.id || parcel.parcel_id,
    searchCount,
    signals: allSignals,
    summary: {
      hasListingHistory,
      hasLifeEvent,
      isAgent,
      hasLinkedIn,
      signalCount: allSignals.length,
    },
    // Enhanced claims for re-inference
    enhancedClaims: {
      listingSignals: allSignals.filter(s => ['active_listing','failed_listing','recently_sold','pending_sale','price_reduction','extended_dom','multiple_listings'].includes(s.type)).map(s => s.detail),
      lifeEventSignals: allSignals.filter(s => ['obituary','divorce','retirement','financial_distress','relocation'].includes(s.type)).map(s => s.detail),
      identitySignals: allSignals.filter(s => ['linkedin_found','is_agent','retired'].includes(s.type)).map(s => s.detail),
      blockerSignals: allSignals.filter(s => s.type === 'is_agent').map(s => s.detail),
    },
  };
}

// Run investigation on a batch of parcels with concurrency control
async function investigateBatch(parcels, concurrency = 3, onProgress) {
  const results = [];
  let completed = 0;
  
  for (let i = 0; i < parcels.length; i += concurrency) {
    const chunk = parcels.slice(i, i + concurrency);
    const chunkResults = await Promise.allSettled(
      chunk.map(p => investigateParcel(p))
    );
    
    for (const r of chunkResults) {
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ parcelId: 'unknown', searchCount: 0, signals: [], summary: { signalCount: 0 }, error: r.reason?.message });
    }
    
    completed += chunk.length;
    if (onProgress) onProgress(completed, parcels.length);
  }
  
  return results;
}

module.exports = { investigateParcel, investigateBatch, searchGoogle, extractSignals, normalizeName };
