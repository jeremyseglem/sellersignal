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
  
  const allText = results.map(r => `${r.title} ${r.snippet}`).join(' ');
  const lower = allText.toLowerCase();
  
  if (label === 'Zillow' || label === 'Redfin' || label === 'Listing') {
    // CRITICAL: Distinguish current vs historical listing status
    // Zillow/Redfin snippets say "off market", "sold", "pending", or show active price
    
    // Previously listed but NOT currently active — strongest prospecting signal
    if (/off\s*market|removed|delisted|withdrawn|expired|cancelled|no longer|previously listed/i.test(lower)) {
      signals.push({ type: 'previously_listed', confidence: 0.85, detail: 'Property was listed but is now off market — possible failed sale or withdrawn listing' });
    }
    
    // Sold to a different owner — property already transferred
    if (/sold\b.*\b20(2[3-6])|closed\b.*\b20(2[3-6])/i.test(lower)) {
      signals.push({ type: 'recently_sold', confidence: 0.7, detail: 'Recent sale detected in listing history' });
    }
    
    // Pending/under contract RIGHT NOW — blocker
    if (/pending|under contract|contingent/i.test(lower) && !/was pending|previously pending|no longer pending/i.test(lower)) {
      signals.push({ type: 'pending_sale', confidence: 0.6, detail: 'Possibly pending — needs verification' });
    }
    
    // Price reductions in history — motivation signal
    if (/price (cut|drop|reduced|change|decrease)|reduced by/i.test(lower)) {
      signals.push({ type: 'price_history', confidence: 0.75, detail: 'Price reductions in listing history — seller motivation' });
    }
    
    // Days on market / listing duration — long DOM = struggling seller
    if (/(\d{3,})\s*days?\s*(on\s*(market|zillow|redfin)|\bdom\b)/i.test(lower)) {
      signals.push({ type: 'extended_dom', confidence: 0.8, detail: 'Extended time on market in listing history' });
    }
    
    // Multiple listing attempts over time
    if (/list(ed|ing)\s*(history|activity)|(\d+)\s*times?\s*(listed|on market)/i.test(lower)) {
      signals.push({ type: 'multiple_listing_attempts', confidence: 0.8, detail: 'Property has been listed multiple times' });
    }
    
    // Has ANY Zillow/Redfin page at all — means it's been on the radar
    if (results.length > 0 && results.some(r => /zillow\.com|redfin\.com/.test(r.link || ''))) {
      signals.push({ type: 'listing_history_exists', confidence: 0.5, detail: 'Property has listing platform history' });
    }
    
    // Price extraction from snippets
    const priceMatch = lower.match(/\$([\d,]+(?:\.\d+)?)\s*(?:k|m)?/i);
    if (priceMatch) signals.push({ type: 'historical_price', confidence: 0.5, detail: priceMatch[0] });
  }
  
  if (label === 'LinkedIn') {
    if (results.length > 0 && results[0].link && /linkedin\.com\/in\//.test(results[0].link)) {
      signals.push({ type: 'linkedin_found', confidence: 0.6, detail: results[0].title });
    }
    if (/retired|retirement|former\s+(ceo|president|director|vp|partner|owner)/i.test(lower)) {
      signals.push({ type: 'retired', confidence: 0.7, detail: 'Retirement indicator from LinkedIn' });
    }
    if (/relocated|moving|moved to|new position in/i.test(lower)) {
      signals.push({ type: 'relocation', confidence: 0.7, detail: 'Relocation indicator from LinkedIn' });
    }
  }
  
  if (label === 'Life Events') {
    if (/obituary|passed away|in loving memory|memorial service|funeral/i.test(lower)) {
      signals.push({ type: 'obituary', confidence: 0.75, detail: 'Possible death connected to this owner or household' });
    }
    if (/divorce|dissolution of marriage|separated/i.test(lower)) {
      signals.push({ type: 'divorce', confidence: 0.7, detail: 'Divorce indicator' });
    }
    if (/retired|retirement|retiring/i.test(lower)) {
      signals.push({ type: 'retirement', confidence: 0.65, detail: 'Retirement indicator' });
    }
    if (/bankrupt|foreclosure|tax\s*lien|delinquent/i.test(lower)) {
      signals.push({ type: 'financial_distress', confidence: 0.8, detail: 'Financial distress indicator' });
    }
  }
  
  if (label === 'Agent Check') {
    if (/real estate agent|realtor|licensed.*broker|associate broker/i.test(lower) && results.some(r => /zillow\.com\/profile|realtor\.com\/realtoragent/i.test(r.link || ''))) {
      signals.push({ type: 'is_agent', confidence: 0.85, detail: 'Owner appears to be a real estate agent — likely not a prospect' });
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
  const hasListingHistory = allSignals.some(s => ['previously_listed','listing_history_exists','multiple_listing_attempts','price_history','extended_dom','recently_sold'].includes(s.type));
  const hasPreviousListing = allSignals.some(s => s.type === 'previously_listed' || s.type === 'multiple_listing_attempts');
  const hasLifeEvent = allSignals.some(s => ['obituary','divorce','retirement','financial_distress','relocation'].includes(s.type));
  const isAgent = allSignals.some(s => s.type === 'is_agent');
  const hasLinkedIn = allSignals.some(s => s.type === 'linkedin_found');
  const isPending = allSignals.some(s => s.type === 'pending_sale');
  
  return {
    parcelId: parcel.id || parcel.parcel_id,
    searchCount,
    signals: allSignals,
    summary: {
      hasListingHistory,
      hasPreviousListing,
      hasLifeEvent,
      isAgent,
      hasLinkedIn,
      isPending,
      signalCount: allSignals.length,
    },
    // Enhanced claims for re-inference
    enhancedClaims: {
      listingSignals: allSignals.filter(s => ['previously_listed','multiple_listing_attempts','price_history','extended_dom'].includes(s.type)).map(s => s.detail),
      lifeEventSignals: allSignals.filter(s => ['obituary','divorce','retirement','financial_distress','relocation'].includes(s.type)).map(s => s.detail),
      identitySignals: allSignals.filter(s => ['linkedin_found','retired','relocation'].includes(s.type)).map(s => s.detail),
      blockerSignals: allSignals.filter(s => ['is_agent','pending_sale'].includes(s.type)).map(s => s.detail),
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
