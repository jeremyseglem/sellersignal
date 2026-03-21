require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3001;

// ===================
// CLIENTS
// ===================
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// Price IDs
const PRICES = {
  pro: process.env.STRIPE_PRICE_PRO || 'price_1StcH2LA5wV9TJQmEYijhf9z',
  team: process.env.STRIPE_PRICE_TEAM || 'price_1StcI4LA5wV9TJQmWVYrPnwx'
};

// Plan limits
const PLAN_LIMITS = {
  free: 3,      // 3 total, not per month
  pro: 50,      // 50 per month
  team: 9999    // unlimited
};

// ===================
// MIDDLEWARE
// ===================
app.use(cors());
app.use(express.static('public'));

// Webhook needs raw body
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ===================
// RATE LIMITING (in-memory, simple)
// ===================
const rateLimits = new Map();

function checkRateLimit(userId, maxRequests = 5, windowMs = 60000) {
  const key = userId || 'anonymous';
  const now = Date.now();
  
  if (!rateLimits.has(key)) {
    rateLimits.set(key, []);
  }
  
  const requests = rateLimits.get(key).filter(time => now - time < windowMs);
  
  if (requests.length >= maxRequests) {
    return false;
  }
  
  requests.push(now);
  rateLimits.set(key, requests);
  return true;
}

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of rateLimits.entries()) {
    const valid = times.filter(t => now - t < 60000);
    if (valid.length === 0) {
      rateLimits.delete(key);
    } else {
      rateLimits.set(key, valid);
    }
  }
}, 300000);

// ===================
// AUTH HELPERS
// ===================
async function getUserFromToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ') || !supabase) {
    return null;
  }
  
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  
  if (error || !user) return null;
  return user;
}

async function getOrCreateProfile(userId, email) {
  if (!supabase) return null;
  
  // Try to get existing profile
  let { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  
  // Create if doesn't exist
  if (!profile) {
    const { data: newProfile, error } = await supabase
      .from('profiles')
      .insert({
        id: userId,
        email: email,
        plan: 'free',
        signals_used: 0,
        signals_limit: PLAN_LIMITS.free,
        created_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (!error) profile = newProfile;
  }
  
  return profile;
}

async function canUseSignal(profile) {
  if (!profile) return { allowed: false, reason: 'Not authenticated' };
  
  const limit = PLAN_LIMITS[profile.plan] || PLAN_LIMITS.free;
  
  // For free users, it's total lifetime. For paid, it's per month.
  if (profile.plan === 'free') {
    if (profile.signals_used >= limit) {
      return { allowed: false, reason: 'Free trial exhausted. Upgrade to continue.' };
    }
  } else {
    // Check if we need to reset monthly count
    const resetDate = new Date(profile.billing_cycle_start || profile.created_at);
    const now = new Date();
    const daysSinceReset = (now - resetDate) / (1000 * 60 * 60 * 24);
    
    if (daysSinceReset >= 30) {
      // Reset the count
      await supabase
        .from('profiles')
        .update({ 
          signals_used: 0, 
          billing_cycle_start: now.toISOString() 
        })
        .eq('id', profile.id);
      profile.signals_used = 0;
    }
    
    if (profile.signals_used >= limit) {
      return { allowed: false, reason: 'Monthly limit reached. Resets on billing date.' };
    }
  }
  
  return { allowed: true };
}

async function incrementSignalCount(userId) {
  if (!supabase) return;
  
  await supabase.rpc('increment_signals', { user_id: userId });
}

// ===================
// SERPAPI SEARCH
// ===================
async function searchGoogle(query) {
  if (!SERPAPI_KEY) {
    console.log('SerpAPI not configured');
    return null;
  }
  
  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}&num=5`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.error) {
      console.log('SerpAPI error:', data.error);
      return null;
    }
    
    return (data.organic_results || []).slice(0, 5).map(r => ({
      title: r.title,
      snippet: r.snippet,
      link: r.link
    }));
  } catch (error) {
    console.log('Search error:', error.message);
    return null;
  }
}


// ===================
// NAME NORMALIZATION — Convert parcel format to searchable format
// ===================
// Parcel data comes as "SEGLEM JEREMY MAXWELL" or "BOND AARON J"
// Needs to become "Jeremy Seglem" or "Aaron J Bond"
function normalizeOwnerName(rawName) {
  if (!rawName) return '';
  
  let name = rawName.trim();
  if (!name) return '';
  
  // Remove suffixes like "& JAMIE A" for couples — keep primary
  const cleanName = name.replace(/\s*&\s*.*$/, '').trim();
  const parts = cleanName.split(/\s+/);
  
  // DETECT PERSON: A person's name in parcel data is typically:
  // "LASTNAME FIRSTNAME" or "LASTNAME FIRSTNAME MIDDLE" 
  // - 2-3 words, all purely alphabetic (with possible period for initials)
  // - No numbers, no common business words
  // Everything that ISN'T clearly a person gets passed through as-is
  
  const businessWords = /LLC|TRUST|LTD|PARTNERSHIP|INC|CORP|ESTATE|FOUNDATION|HOLDINGS|COMPANY|GROUP|RANCH|FARM|PROPERTIES|INVESTMENTS|ASSOCIATES|VENTURES|ENTERPRISES|PARTNERS|DEVELOPMENT|DEVELOPERS|REALTY|MANAGEMENT|CLUB|LAND|HOMES|BUILDERS|CONSTRUCTION|CAPITAL|CHURCH|CITY|COUNTY|STATE|SCHOOL|DISTRICT|HOA|ASSOCIATION|BANK|MORTGAGE|SERVICES|RENTALS|CONSULTING|INDUSTRIES|HOUSING|AUTHORITY|AGENCY/i;
  
  // If any word matches a business term, it's an entity
  if (businessWords.test(cleanName)) return name;
  
  // If name contains numbers (like "CIRCLE 4 RANCH" or "123 HOLDINGS"), entity
  if (/\d/.test(cleanName)) return name;
  
  // If only 1 word, probably an entity or nickname — pass through
  if (parts.length < 2) return name;
  
  // If more than 3 words, probably an entity (people rarely have 4+ name parts in parcel data)
  if (parts.length > 3) return name;
  
  // 2-3 words, all alphabetic, no business terms — this is a person
  // Check all parts are purely alpha (allowing periods and hyphens for initials/hyphenated names)
  const allAlpha = parts.every(p => /^[A-Za-z][A-Za-z.\-']*$/.test(p));
  if (!allAlpha) return name;
  
  // It's a person — normalize from "LASTNAME FIRSTNAME MIDDLE" to "Firstname Lastname"
  const titleCase = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  
  const lastName = titleCase[0];
  const firstName = titleCase[1];
  const middle = titleCase.slice(2).join(' ');
  
  return {
    full: middle ? `${firstName} ${middle} ${lastName}` : `${firstName} ${lastName}`,
    searchPrimary: `${firstName} ${lastName}`,
    first: firstName,
    last: lastName,
    original: name
  };
}

// Throttled batch search implementation
async function searchBatch(queries, onProgress) {
  const output = {};
  const batchSize = 12;
  let completed = 0;
  
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    const promises = batch.map(async (q) => {
      const results = await searchGoogle(q.query);
      return { label: q.label, results: results || [] };
    });
    
    const settled = await Promise.allSettled(promises);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        output[result.value.label] = result.value.results;
      }
    }
    completed += batch.length;
    if (onProgress) onProgress(completed, queries.length);
    
    if (i + batchSize < queries.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  return output;
}

// ===================
// TIERED RESEARCH v4 — Fast core searches first, conditional escalation
// ===================
async function gatherSearchResultsV2(ownerName, streetAddress, city, state, onProgress) {
  console.log('Deep Signal v4: Tiered search...');
  
  const normalized = normalizeOwnerName(ownerName);
  const searchName = typeof normalized === 'object' ? normalized.searchPrimary : ownerName;
  const fullName = typeof normalized === 'object' ? normalized.full : ownerName;
  const firstName = typeof normalized === 'object' ? normalized.first : (ownerName.trim().split(' ')[0] || '');
  const lastName = typeof normalized === 'object' ? normalized.last : (ownerName.trim().split(' ').pop() || '');
  const isEntity = /LLC|TRUST|LTD|PARTNERSHIP|INC|CORP|ESTATE|FOUNDATION|HOLDINGS|COMPANY|GROUP|RANCH|FARM|PROPERTIES|INVESTMENTS|ASSOCIATES|VENTURES|ENTERPRISES|PARTNERS|DEVELOPMENT|DEVELOPERS|REALTY|MANAGEMENT/i.test(ownerName);
  
  console.log(`  Raw: "${ownerName}" → Search: "${searchName}" | Entity: ${isEntity}`);
  const startTime = Date.now();
  const allResults = {};
  let totalSearches = 0;

  // -----------------------------------------------
  // TIER 1: Core searches — always run (~14 searches, ~5-7 seconds)
  // Property data + primary owner identity + key people search
  // -----------------------------------------------
  const tier1 = [
    // Property (4)
    { label: 'Zillow', query: `"${streetAddress}" "${city}" site:zillow.com` },
    { label: 'Redfin', query: `"${streetAddress}" "${city}" site:redfin.com` },
    { label: 'Realtor.com', query: `"${streetAddress}" "${city}" site:realtor.com` },
    { label: 'County Tax', query: `"${streetAddress}" "${city}" ${state} tax assessor property` },
    // Owner identity (4)
    { label: 'Broad Identity', query: `${searchName} ${city}` },
    { label: 'Owner+City+State', query: `"${searchName}" "${city}" ${state}` },
    { label: 'FastPeopleSearch', query: `"${searchName}" "${city}" site:fastpeoplesearch.com` },
    { label: 'LinkedIn', query: `"${searchName}" ${city} ${state} site:linkedin.com` },
    // Agent detection (1 broad check)
    { label: 'RE Agent General', query: `"${searchName}" "${city}" realtor OR "real estate agent" OR broker` },
    // Life signals (1)
    { label: 'Life Events', query: `"${searchName}" "${city}" ${state} retired OR retirement OR divorce OR obituary` },
    // News (1)
    { label: 'News', query: `"${searchName}" "${city}" ${state} news OR article` },
  ];
  
  // Entity-specific tier 1
  if (isEntity) {
    const entityName = ownerName.trim();
    const stateAbbr = state.trim().toUpperCase();
    tier1.push(
      { label: 'SOS Registered Agent', query: `"${entityName}" ${stateAbbr} registered agent secretary of state` },
      { label: 'Entity Members', query: `"${entityName}" ${stateAbbr} member OR manager OR officer OR principal` },
      { label: 'Entity OpenCorporates', query: `"${entityName}" ${stateAbbr} site:opencorporates.com` }
    );
  }

  console.log(`  Tier 1: ${tier1.length} core searches...`);
  if (onProgress) onProgress(0, tier1.length, 'Searching core data sources...');
  
  const t1Results = await searchBatch(tier1, onProgress);
  Object.assign(allResults, t1Results);
  totalSearches += tier1.length;
  
  const t1Elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const t1NonEmpty = Object.values(t1Results).filter(r => r.length > 0).length;
  console.log(`  Tier 1 complete in ${t1Elapsed}s — ${t1NonEmpty}/${tier1.length} returned results`);

  // -----------------------------------------------
  // TIER 2: Conditional gap-fill (~8-12 searches, ~3-5 seconds)
  // Only runs searches where Tier 1 left gaps
  // -----------------------------------------------
  const tier2 = [];
  
  // Property gaps
  if (!(t1Results['Zillow']?.length) && !(t1Results['Redfin']?.length)) {
    tier2.push({ label: 'Trulia', query: `"${streetAddress}" "${city}" site:trulia.com` });
    tier2.push({ label: 'Property History', query: `"${streetAddress}" "${city}" sold sale listing history` });
  }
  
  // LinkedIn gap
  if (!(t1Results['LinkedIn']?.length)) {
    tier2.push({ label: 'LinkedIn Alt', query: `"${firstName} ${lastName}" ${state} site:linkedin.com` });
    tier2.push({ label: 'Professional Profile', query: `"${searchName}" "${city}" ${state} professional OR career OR work` });
  }
  
  // People search gap — only run backup sources if FastPeopleSearch was empty
  if (!(t1Results['FastPeopleSearch']?.length)) {
    tier2.push({ label: 'WhitePages', query: `"${searchName}" "${city}" ${state} site:whitepages.com` });
    tier2.push({ label: 'Spokeo', query: `"${searchName}" "${city}" site:spokeo.com` });
  }
  
  // Owner connection — only if broad search was weak
  if (!(t1Results['Owner+City+State']?.length)) {
    tier2.push({ label: 'Owner at Address', query: `"${searchName}" "${streetAddress}"` });
    tier2.push({ label: 'Owner+State', query: `"${searchName}" ${state}` });
  }
  
  // Agent detection expansion — only if broad check found hits
  if (t1Results['RE Agent General']?.length > 0) {
    tier2.push({ label: 'Zillow Agent', query: `"${searchName}" ${city} ${state} site:zillow.com/profile` });
    tier2.push({ label: 'Brokerage Bio', query: `"${searchName}" "${city}" ${state} brokerage OR "realty" bio OR team` });
  }
  
  // Business/company — always useful
  tier2.push({ label: 'Business Owner', query: `"${searchName}" "${city}" business owner` });
  
  // Entity SOS expansion
  if (isEntity && !(t1Results['SOS Registered Agent']?.length)) {
    const entityName = ownerName.trim();
    const stateAbbr = state.trim().toUpperCase();
    tier2.push({ label: 'SOS MT', query: `"${entityName}" site:sos.mt.gov` });
    tier2.push({ label: 'SOS WA', query: `"${entityName}" site:sos.wa.gov` });
    tier2.push({ label: 'SOS Business Filing', query: `"${entityName}" ${stateAbbr} business entity filing` });
  }

  if (tier2.length > 0) {
    console.log(`  Tier 2: ${tier2.length} gap-fill searches...`);
    if (onProgress) onProgress(totalSearches, totalSearches + tier2.length, 'Filling data gaps...');
    
    const t2Results = await searchBatch(tier2, onProgress);
    Object.assign(allResults, t2Results);
    totalSearches += tier2.length;
    
    const t2NonEmpty = Object.values(t2Results).filter(r => r.length > 0).length;
    console.log(`  Tier 2 complete — ${t2NonEmpty}/${tier2.length} returned results`);
  } else {
    console.log(`  Tier 2: skipped — no gaps detected`);
  }

  // -----------------------------------------------
  // TIER 3: Enrichment — only if data is still thin
  // Social, family, community, court records
  // -----------------------------------------------
  const totalItemsSoFar = Object.values(allResults).reduce((sum, r) => sum + r.length, 0);
  const needsEnrichment = totalItemsSoFar < 30; // If we have fewer than 30 result items, dig deeper
  
  if (needsEnrichment) {
    const tier3 = [
      { label: 'Facebook', query: `"${searchName}" "${city}" ${state} site:facebook.com` },
      { label: 'Family', query: `"${searchName}" "${city}" spouse OR wife OR husband OR family` },
      { label: 'Community', query: `"${searchName}" "${city}" ${state} board OR volunteer OR foundation OR donation` },
      { label: 'Other Properties', query: `"${searchName}" ${state} property OR parcel OR deed -"${streetAddress}"` },
      { label: 'Court Records', query: `"${searchName}" "${city}" ${state} court OR filing OR lien OR judgment` },
      { label: 'Phone Email', query: `"${searchName}" "${city}" ${state} phone OR email OR contact` },
      { label: 'Age Records', query: `"${searchName}" "${city}" age OR born OR birthday` },
      { label: 'Relocation', query: `"${searchName}" "moving" OR "relocated" OR "new home" OR "downsizing"` },
    ];
    
    console.log(`  Tier 3: ${tier3.length} enrichment searches (thin data: ${totalItemsSoFar} items)...`);
    if (onProgress) onProgress(totalSearches, totalSearches + tier3.length, 'Running deep enrichment...');
    
    const t3Results = await searchBatch(tier3, onProgress);
    Object.assign(allResults, t3Results);
    totalSearches += tier3.length;
    
    const t3NonEmpty = Object.values(t3Results).filter(r => r.length > 0).length;
    console.log(`  Tier 3 complete — ${t3NonEmpty}/${tier3.length} returned results`);
  } else {
    console.log(`  Tier 3: skipped — sufficient data (${totalItemsSoFar} items)`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalItems = Object.values(allResults).reduce((sum, r) => sum + r.length, 0);
  const nonEmpty = Object.values(allResults).filter(r => r.length > 0).length;
  console.log(`  TOTAL: ${totalSearches} searches in ${elapsed}s — ${nonEmpty} returned results (${totalItems} items)`);

  // Organize into layers for formatting
  return {
    propertyResults: Object.fromEntries(Object.entries(allResults).filter(([k]) => 
      ['Zillow','Redfin','Realtor.com','Trulia','County Tax','Property History','Neighborhood'].includes(k))),
    ownerResults: Object.fromEntries(Object.entries(allResults).filter(([k]) => 
      ['Owner at Address','Owner+Address+City','Owner+City+State','Owner+State','LinkedIn','LinkedIn Alt','FastPeopleSearch','WhitePages','Spokeo','Business Owner','Company','Professional Profile','Phone Email','Age Records'].includes(k))),
    intentResults: Object.fromEntries(Object.entries(allResults).filter(([k]) => 
      ['Facebook','News','Family','Marriage','Life Events','Relocation','Community','Other Properties','Court Records'].includes(k))),
    connectionResults: Object.fromEntries(Object.entries(allResults).filter(([k]) => 
      ['Zillow Agent','Realtor.com Agent','Redfin Agent','RE Agent General','Brokerage Bio','Agent Reviews','Agent Transactions','SOS Registered Agent','SOS Business Filing','SOS MT','SOS WA','Entity Members','Entity OpenCorporates'].includes(k)))
  };
}

function formatLayeredResults(layers) {
  let formatted = '';
  formatted += '=== PROPERTY DATA ===\n';
  for (const [label, results] of Object.entries(layers.propertyResults)) {
    formatted += `[${label}]\n`;
    if (results.length === 0) formatted += 'No results\n';
    else for (const r of results) formatted += `• ${r.title}\n  ${r.snippet || ''}\n  ${r.link}\n`;
    formatted += '\n';
  }
  formatted += '=== OWNER IDENTITY ===\n';
  for (const [label, results] of Object.entries(layers.ownerResults)) {
    formatted += `[${label}]\n`;
    if (results.length === 0) formatted += 'No results\n';
    else for (const r of results) formatted += `• ${r.title}\n  ${r.snippet || ''}\n  ${r.link}\n`;
    formatted += '\n';
  }
  formatted += '=== INTENT & LIFE SIGNALS ===\n';
  for (const [label, results] of Object.entries(layers.intentResults)) {
    formatted += `[${label}]\n`;
    if (results.length === 0) formatted += 'No results\n';
    else for (const r of results) formatted += `• ${r.title}\n  ${r.snippet || ''}\n  ${r.link}\n`;
    formatted += '\n';
  }
  formatted += '=== CONNECTIONS & CONTEXT ===\n';
  for (const [label, results] of Object.entries(layers.connectionResults || {})) {
    formatted += `[${label}]\n`;
    if (results.length === 0) formatted += 'No results\n';
    else for (const r of results) formatted += `• ${r.title}\n  ${r.snippet || ''}\n  ${r.link}\n`;
    formatted += '\n';
  }
  return formatted;
}

// Keep old function for backward compatibility with existing /api/research
async function gatherSearchResults(ownerName, streetAddress, city, state) {
  console.log('Running comprehensive searches...');
  
  const nameParts = ownerName.trim().split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts[nameParts.length - 1] || '';
  
  const searches = [
    // Property searches
    { label: 'Zillow Property', query: `"${streetAddress}" "${city}" site:zillow.com` },
    { label: 'Redfin Property', query: `"${streetAddress}" "${city}" site:redfin.com` },
    { label: 'Realtor Property', query: `"${streetAddress}" "${city}" site:realtor.com` },
    { label: 'Trulia Property', query: `"${streetAddress}" "${city}" site:trulia.com` },
    { label: 'County Tax Records', query: `"${streetAddress}" "${city}" ${state} tax assessor property` },
    { label: 'County Property Records', query: `"${streetAddress}" ${city} ${state} county property records deed` },
    
    // Owner + address connection
    { label: 'Owner at Address', query: `"${ownerName}" "${streetAddress}"` },
    { label: 'Owner Address City', query: `"${ownerName}" "${streetAddress}" "${city}"` },
    { label: 'Owner City State', query: `"${ownerName}" "${city}" ${state}` },
    { label: 'Owner State', query: `"${ownerName}" ${state}` },
    
    // Real estate agent specific searches (HIGH PRIORITY)
    { label: 'Zillow Agent Profile', query: `"${ownerName}" ${city} ${state} site:zillow.com/profile` },
    { label: 'Realtor.com Agent', query: `"${ownerName}" ${city} ${state} site:realtor.com/realestateagents` },
    { label: 'Redfin Agent', query: `"${ownerName}" ${city} ${state} site:redfin.com/real-estate-agents` },
    { label: 'Real Estate Agent', query: `"${ownerName}" "${city}" realtor OR "real estate agent" OR broker` },
    { label: 'Brokerage Bio', query: `"${ownerName}" "${city}" ${state} brokerage OR "realty" bio OR team` },
    { label: 'Agent Reviews', query: `"${ownerName}" "${city}" agent reviews OR testimonials OR sold` },
    { label: 'Agent Transactions', query: `"${ownerName}" "${city}" ${state} listings OR transactions OR closed` },
    
    // Professional
    { label: 'LinkedIn', query: `"${ownerName}" ${city} ${state} site:linkedin.com` },
    { label: 'LinkedIn Alt', query: `"${firstName} ${lastName}" ${state} site:linkedin.com` },
    { label: 'Business Owner', query: `"${ownerName}" "${city}" business owner` },
    { label: 'Company', query: `"${ownerName}" "${city}" ${state} company OR LLC OR inc` },
    { label: 'Professional', query: `"${ownerName}" "${city}" ${state} professional OR career OR work` },
    
    // People search
    { label: 'FastPeopleSearch', query: `"${ownerName}" "${city}" site:fastpeoplesearch.com` },
    { label: 'WhitePages', query: `"${ownerName}" "${city}" ${state} site:whitepages.com` },
    { label: 'Spokeo', query: `"${ownerName}" "${city}" site:spokeo.com` },
    
    // Social + news
    { label: 'Facebook', query: `"${ownerName}" "${city}" ${state} site:facebook.com` },
    { label: 'News Mentions', query: `"${ownerName}" "${city}" ${state} news OR article` },
    
    // Family + property context
    { label: 'Family Records', query: `"${ownerName}" "${city}" spouse OR wife OR husband OR family` },
    { label: 'Marriage Records', query: `"${ownerName}" ${state} marriage OR wedding` },
    { label: 'Property History', query: `"${streetAddress}" "${city}" sold OR sale OR listing history` },
    { label: 'Neighborhood', query: `"${streetAddress}" "${city}" neighborhood OR area` }
  ];
  
  const results = {};
  
  for (const search of searches) {
    console.log(`  Searching: ${search.label}`);
    const searchResults = await searchGoogle(search.query);
    results[search.label] = searchResults || [];
    await new Promise(r => setTimeout(r, 100));
  }
  
  return results;
}

function formatSearchResultsForClaude(searchResults) {
  let formatted = 'SEARCH RESULTS:\n\n';
  
  for (const [label, results] of Object.entries(searchResults)) {
    formatted += `=== ${label} ===\n`;
    if (results.length === 0) {
      formatted += 'No results found\n';
    } else {
      for (const r of results) {
        formatted += `• ${r.title}\n  ${r.snippet || 'No description'}\n  ${r.link}\n\n`;
      }
    }
    formatted += '\n';
  }
  
  return formatted;
}

// ===================
// CACHING
// ===================
function getCacheKey(ownerName, propertyAddress) {
  return `${ownerName.toLowerCase().trim()}|${propertyAddress.toLowerCase().trim()}`;
}

async function getFromCache(ownerName, propertyAddress) {
  if (!supabase) return null;
  const cacheKey = getCacheKey(ownerName, propertyAddress);
  const { data } = await supabase
    .from('signals_cache')
    .select('result')
    .eq('cache_key', cacheKey)
    .gt('expires_at', new Date().toISOString())
    .single();
  return data?.result || null;
}

async function saveToCache(ownerName, propertyAddress, result) {
  if (!supabase) return;
  const cacheKey = getCacheKey(ownerName, propertyAddress);
  await supabase
    .from('signals_cache')
    .upsert({
      owner_name: ownerName,
      property_address: propertyAddress,
      cache_key: cacheKey,
      result: result,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    }, { onConflict: 'cache_key' });
}

// ===================
// RESEARCH ENDPOINT
// ===================
app.post('/api/research', async (req, res) => {
  try {
    const { ownerName, propertyAddress } = req.body;
    
    if (!ownerName || !propertyAddress) {
      return res.status(400).json({ error: 'Owner name and property address required' });
    }

    // Get user from auth header
    const user = await getUserFromToken(req.headers.authorization);
    
    if (!user) {
      return res.status(401).json({ error: 'Please sign in to use SellerSignal' });
    }

    // Rate limiting
    if (!checkRateLimit(user.id, 5, 60000)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
    }

    // Get/create profile and check limits
    const profile = await getOrCreateProfile(user.id, user.email);
    const { allowed, reason } = await canUseSignal(profile);
    
    if (!allowed) {
      return res.status(403).json({ error: reason, upgrade: true });
    }

    // Check cache first
    const cached = await getFromCache(ownerName, propertyAddress);
    if (cached) {
      // Still counts against limit even if cached
      await incrementSignalCount(user.id);
      return res.json(cached);
    }

    console.log(`Researching: ${ownerName} at ${propertyAddress}`);

    // Parse address
    const addressParts = propertyAddress.split(',').map(s => s.trim());
    const streetAddress = addressParts[0] || '';
    const city = addressParts[1] || '';
    const stateZip = addressParts[2] || '';
    const state = stateZip.split(' ')[0] || '';

    // Gather search results
    const searchResults = await gatherSearchResults(ownerName, streetAddress, city, state);
    const formattedResults = formatSearchResultsForClaude(searchResults);

    const systemPrompt = `You are a real estate research analyst. You will be given REAL search results from Google. Your job is to analyze these results and extract relevant information about the property owner.

IMPORTANT RULES:
1. ONLY use information that appears in the search results provided
2. If information is not in the search results, mark it as "Not found"
3. Do NOT make up or infer information that isn't explicitly in the results

DETECTING REAL ESTATE PROFESSIONALS:
If the search results indicate this person is a real estate agent, broker, or works in real estate:
- Pull ALL available details: brokerage name, years in business, specialties, transaction count, reviews
- Note their production level if visible (top producer, team lead, etc.)
- Include awards, certifications, or designations
- Note market areas they focus on
- Include any team members or assistants mentioned
- Their occupation should be formatted as: "Real Estate Agent at [Brokerage]" or "Broker/Owner at [Company]"
- For agents, be EXTRA thorough - they have rich online profiles, so mine every detail

PROPERTY ANALYSIS:
- Look for Zillow/Redfin data: price, beds, baths, sqft, year built, sale history
- Look for ownership records: purchase date, price paid
- For Montana properties, Zillow estimates may be 20-30% below market

OWNER ANALYSIS:
- Look for LinkedIn profile: job title, employer, location
- Look for news articles or business listings
- Look for any public records mentioning the owner
- Look for Zillow/Realtor.com/Redfin agent profiles
- Look for brokerage bio pages

SELLER LIKELIHOOD SCORING (0-100):
Start at 35 (baseline). Adjust based on findings:
- Young family indicators: -20
- Recent purchase (last 2-3 years): -15  
- Renovations/improvements: -15
- Long ownership (15+ years): +10
- Age 60+: +15
- Empty nester indicators: +10
- Out of state owner: +15

PERSONALITY INSIGHTS:
Based on their profession, life stage, and background, infer:
- Are they a numbers person (data-driven, wants facts/figures) or relationship person (trust-based, wants rapport)?
- Are they likely cautious/analytical or quick decision makers?
- What life transitions might they be facing? (retirement, kids leaving, career change, etc.)
- What would motivate them to move? (lifestyle upgrade, downsizing, relocation, financial opportunity)
- What are they likely proud of? (career, family, home improvements, community standing)
- What concerns might hold them back from selling?

WEALTH INDICATORS:
Look for evidence of financial status:
- Business ownership, executive positions, professional credentials
- Foundation/charitable giving (search for family foundations, donor records)
- Multiple properties, investment properties, vacation homes
- Luxury indicators (boats, planes, club memberships mentioned)
- Company acquisitions, IPOs, or major business events
- Board memberships, advisory roles
- Career trajectory in high-income sectors (finance, tech, medicine, law, executive)
- Neighborhood/property value relative to area median
Estimate net worth range if evidence supports it (e.g., "Mid six figures", "Low seven figures", "High seven to low eight figures")

Return ONLY valid JSON. Do NOT include source citations like "(from Zillow)" - just state the facts:
{
    "name": "Full name",
    "address": "Full address",
    "score": 0-100,
    "scoreLabel": "High Likelihood" or "Medium Likelihood" or "Low Likelihood",
    "metrics": {
        "estimatedValue": "$XXX,XXX or Not found",
        "estimatedEquity": "$XXX,XXX or Not found",
        "ownedSince": "YYYY or Not found",
        "ageRange": "XX-XX or Not found"
    },
    "wealthIndicators": {
        "incomeLevel": "Estimated income bracket or career-based estimate",
        "netWorthEstimate": "Range estimate with reasoning (e.g., 'High six figures based on 20-year executive career and property values')",
        "evidence": ["List of specific wealth signals found - business ownership, foundation, properties, etc."],
        "financialSophistication": "Low/Medium/High - based on career, investments, business ownership"
    },
    "whoTheyAre": {
        "spouse": "Name or Not found",
        "occupation": "Job title at Company or Not found",
        "ownership": "How title is held",
        "decisionStyle": "Description"
    },
    "howTheyThink": {
        "financialMindset": "Description",
        "communication": "Description",
        "socialPosition": "Description",
        "bestChannel": "Letter/Phone/Email/Door"
    },
    "whatMakesThemTick": {
        "personalityType": "Numbers Person or Relationship Person - with brief explanation",
        "decisionSpeed": "Analytical/Cautious or Decisive/Quick - with brief explanation",
        "lifeStage": "Description of where they are in life (e.g., 'Empty nester approaching retirement', 'Young professional building career')",
        "motivators": "What would make them want to move",
        "pridePoints": "What they're likely proud of - use this to build rapport",
        "concerns": "What might hold them back from selling"
    },
    "signals": [
        {"text": "Signal description", "type": "positive"},
        {"text": "Signal description", "type": "negative"},
        {"text": "Signal description", "type": "neutral"}
    ],
    "approach": {
        "opening": "Recommended approach",
        "keyMessages": "Key points",
        "avoid": "What to avoid",
        "timing": "Best time/situation to reach out"
    },
    "scripts": {
        "letter": "Personalized letter. Use [AGENT_NAME] and [AGENT_PHONE] placeholders.",
        "phone": "Phone script.",
        "door": "Door knock script.",
        "email": "Subject line first, then body."
    }
}

SIGNAL TYPES:
- "positive" = indicates higher likelihood to sell
- "negative" = indicates lower likelihood to sell
- "neutral" = informational`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `Analyze these search results for the property owner "${ownerName}" at "${propertyAddress}".

${formattedResults}

Extract all relevant information and generate the JSON report. Only include information that actually appears in these search results.`
      }],
      system: systemPrompt
    });

    let textContent = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      }
    }

    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse response');

    const result = JSON.parse(jsonMatch[0]);
    
    // Save to cache
    await saveToCache(ownerName, propertyAddress, result);
    
    // Increment usage
    await incrementSignalCount(user.id);
    
    // Save to history
    if (supabase) {
      const { error: historyError } = await supabase.from('signals_history').insert({
        user_id: user.id,
        owner_name: ownerName,
        property_address: propertyAddress,
        score: result.score,
        result: result
      });
      if (historyError) {
        console.error('History insert error:', historyError);
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Research error:', error);
    res.status(500).json({ error: error.message || 'Research failed' });
  }
});

// ===================
// USER PROFILE
// ===================
app.get('/api/profile', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const profile = await getOrCreateProfile(user.id, user.email);
  if (!profile) {
    return res.status(500).json({ error: 'Could not load profile' });
  }
  
  res.json({
    id: profile.id,
    email: profile.email,
    plan: profile.plan,
    signals_used: profile.signals_used,
    signals_limit: PLAN_LIMITS[profile.plan] || PLAN_LIMITS.free,
    created_at: profile.created_at
  });
});

// ===================
// HISTORY
// ===================
app.get('/api/history', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  if (!supabase) {
    return res.json([]);
  }
  
  const { data, error } = await supabase
    .from('signals_history')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  
  res.json(data || []);
});

// ===================
// STRIPE CHECKOUT
// ===================
app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Payments not configured' });
  }
  
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) {
    return res.status(401).json({ error: 'Please sign in first' });
  }
  
  const { plan } = req.body;
  const priceId = PRICES[plan];
  
  if (!priceId) {
    return res.status(400).json({ error: 'Invalid plan' });
  }
  
  try {
    const profile = await getOrCreateProfile(user.id, user.email);
    
    // Get or create Stripe customer
    let customerId = profile?.stripe_customer_id;
    
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id }
      });
      customerId = customer.id;
      
      // Save customer ID
      if (supabase) {
        await supabase
          .from('profiles')
          .update({ stripe_customer_id: customerId })
          .eq('id', user.id);
      }
    }
    
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.APP_URL || 'https://sellersignal.co'}/app.html?success=true`,
      cancel_url: `${process.env.APP_URL || 'https://sellersignal.co'}/app.html?canceled=true`,
      metadata: { userId: user.id, plan: plan }
    });
    
    res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===================
// STRIPE WEBHOOK
// ===================
app.post('/api/webhook', async (req, res) => {
  if (!stripe || !supabase) {
    return res.status(500).send('Not configured');
  }
  
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  console.log('Webhook event:', event.type);
  
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan || 'pro';
      
      if (userId) {
        await supabase
          .from('profiles')
          .update({
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            plan: plan,
            signals_used: 0,
            signals_limit: PLAN_LIMITS[plan],
            billing_cycle_start: new Date().toISOString()
          })
          .eq('id', userId);
        
        console.log(`User ${userId} upgraded to ${plan}`);
      }
      break;
    }
    
    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      
      // Find user by customer ID
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .single();
      
      if (profile) {
        const status = subscription.status;
        if (status === 'active') {
          // Subscription renewed or updated
          await supabase
            .from('profiles')
            .update({
              stripe_subscription_id: subscription.id,
              billing_cycle_start: new Date().toISOString()
            })
            .eq('id', profile.id);
        }
      }
      break;
    }
    
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      
      // Downgrade to free
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .single();
      
      if (profile) {
        await supabase
          .from('profiles')
          .update({
            plan: 'free',
            stripe_subscription_id: null,
            signals_limit: PLAN_LIMITS.free
          })
          .eq('id', profile.id);
        
        console.log(`User ${profile.id} downgraded to free`);
      }
      break;
    }
  }
  
  res.json({ received: true });
});

// ===================
// BILLING PORTAL
// ===================
app.post('/api/billing-portal', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Payments not configured' });
  }
  
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const profile = await getOrCreateProfile(user.id, user.email);
  
  if (!profile?.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found' });
  }
  
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.APP_URL || 'https://sellersignal.co'}/app.html`
    });
    
    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===================
// SHARED DEEP SIGNAL PROMPT — used by both POST and SSE endpoints
// ===================
function buildDeepSignalPrompt(propertyAddress, preliminaryScore, city) {
  return `You are SellerSignal's Deep Signal engine — an expert real estate predictive modeling system specializing in off-market seller propensity. You analyze residential property owners and assign a seller likelihood score based on behavioral, ownership, demographic, financial, market-position, and operational signals.

CRITICAL RULES:
- The property being evaluated is at "${propertyAddress}". ALL scripts and market references must be about THIS location.
- Do NOT use a one-size-fits-all model. Segment the owner first, then apply segment-specific logic.
- "Not found" is a last resort. Infer from property data, ownership patterns, and neighborhood context when direct data is absent. Label inferences clearly.
- Extract ALL phone numbers, email addresses, ages, and spouse names from search results — especially from FastPeopleSearch, WhitePages, Spokeo snippets.
- If the owner is an entity and a principal/member has been identified, build the profile around THAT PERSON.
- COUNTY ASSESSED VALUES ARE TAX BASIS ONLY — they are often 30-80% below actual market value, especially in Montana. NEVER use assessed value as estimated market value. Use Zillow/Redfin/Realtor estimates from search results for the estimatedMarketValue field. If no listing-site estimate is found, note "Not found from search data" — do NOT fall back to assessed value.

STEP 1: SEGMENT THE OWNER

Classify the property owner into the PRIMARY cohort that best fits. Choose one:

A. NEVER-LISTED LEGACY OWNER — Property has no meaningful listing history. Owner may be highly private, older legacy owner, emotionally attached but reaching transition point, resistant to showings/prep, unaware of current value, or burdened by maintenance/inheritance/life stage change.

B. LONG-TERM OWNER (10+ YEARS) — Held 10+ years. May have locked-in equity, deferred decisions approaching release, downsizing needs, relocation pressure, family transition, equity harvest motivation, tax/insurance/maintenance pressure, or self-management burnout.

C. INVESTOR / ENTITY OWNER — LLC, trust, business entity, or multi-property holder. Assess portfolio fatigue, underperformance, tenant issues, cap-rate compression, insurance/tax increases, deferred maintenance, vacancy risk, geographic distance, aging investor succession, portfolio simplification, 1031 timing, or debt maturity pressure.

D. LUXURY / HIGH-END OWNER — Upper market percentile. May be underserved by entrenched legacy agent relationships with slow responsiveness, outdated marketing, overreliance on relationship equity, insufficient discretion, or poor alignment with seller timing. Evaluate whether seller would prioritize certainty, privacy, timing, or simplicity over top-dollar theater.

E. OVERLOOKED TRANSITION OWNER — Falls outside typical lead timelines: pre-probate/inherited not yet liquidated, divorcing, aging owner with high-maintenance home, absentee with non-owner mail, second-home with declining utility, recent liens but not full distress, substantial equity with life-transition signals, functionally obsolete home, tax/insurance pressure neighborhood, household mismatch, missed selling season, vacant/underutilized, partial renovation abandoned, trust with unclear occupant.

STEP 2: EVALUATE WITH SEGMENT-SPECIFIC SIGNALS

For the identified segment, weight these signal categories:

IMMEDIATE TRIGGER SIGNALS (highest weight):
- Death of co-owner, estate/probate filing, recent divorce
- Active code violations, tax delinquency, pre-foreclosure
- Expired/withdrawn/terminated listing within 12 months
- Bank/lender ownership (REO)
- Recent job relocation confirmed

LATENT DISPOSITION SIGNALS:
- Ownership duration vs market median tenure (national median: 11 years)
- Owner age relative to median seller age (national median: 64)
- Empty-nester indicators (large home, long tenure, age 55+)
- Equity position (purchase price vs current value)
- Free-and-clear ownership (25+ year tenure)
- Multiple property ownership

FRICTION-TO-LIST SIGNALS (why they'd sell off-market instead of MLS):
- Privacy preference (luxury, public figure, entity ownership)
- Property condition issues (deferred maintenance, partial renovation)
- Aversion to market prep (staging, showings, open houses)
- Unique/niche property with thin buyer pool
- Emotional attachment making public listing feel invasive
- Legacy ownership where formal listing feels like betrayal of history

OFF-MARKET PREFERENCE SIGNALS:
- Entity/trust structure suggests sophistication and discretion preference
- High-value property where exposure could attract unwanted attention
- Rural/agricultural property where MLS is inefficient
- Owner has sold off-market before (multiple properties, no listing history)
- Investor mindset (portfolio owner, numbers-driven, values speed/certainty)

FINANCIAL PRESSURE SIGNALS:
- High tax burden relative to use (absentee + high assessed value)
- Mortgage rate lock-in friction (purchased 2020-2021 at ~3%)
- Rising insurance/HOA costs
- Deferred maintenance creating compounding cost pressure
- Rent-to-value inefficiency (investor properties)

LIFE-STAGE TRANSITION SIGNALS:
- Retirement (confirmed or approaching based on age 60+)
- Downsizing indicators (large home, aging owner, long tenure)
- Health decline (estate/trust creation, power of attorney)
- Children left home (family home, 20+ year tenure, owner 55+)
- Career change or relocation

OPERATIONAL BURDEN SIGNALS:
- Self-managing rental from out of state
- Large lot/acreage with high maintenance requirements
- Aging property requiring major systems replacement
- Agricultural operation with succession uncertainty
- Multi-unit with tenant management burden

STEP 3: SCORE AND CLASSIFY

Start at ${preliminaryScore || 35} (from parcel data). Adjust based on confirmed/inferred findings using segment-appropriate weights.

Score bands:
80-100: VERY HIGH — Multiple immediate triggers. Probable disposition within 0-6 months. Aggressive outreach warranted.
60-79: HIGH — Strong latent signals with approaching catalyst. Probable 3-12 months. Active prospecting recommended.
40-59: MODERATE — Meaningful signals but no clear catalyst yet. 6-24 month horizon. Nurture campaign appropriate.
20-39: LOW — Few positive signals or strong stay-in-place indicators. 12-24+ months. Passive monitoring only.
0-19: UNLIKELY — Active investment in property, recent purchase, young family, or strong attachment indicators.

STEP 4: ASSESS OFF-MARKET RECEPTIVITY

Separately evaluate: Would this owner prefer a discreet off-market sale over traditional MLS listing? Rate 0-100.

High off-market receptivity:
- Entity ownership with sophistication signals
- Privacy-sensitive owner (luxury, public figure)
- Property condition makes listing embarrassing
- Legacy owner who won't do staging/showings
- Investor who values certainty/speed over top dollar
- Rural/agricultural where MLS is irrelevant
- Previous off-market transaction pattern

Low off-market receptivity:
- Young/tech-savvy owner who'd maximize exposure
- Recently renovated/show-ready property
- Owner is a real estate agent themselves
- Property in high-demand area where bidding wars are likely

STEP 5: IDENTIFY RED FLAGS / FALSE POSITIVES

Call out if the owner looks like a seller but probably isn't:
- Agricultural operation with active subsidies and no succession pressure
- Long-term owner who recently renovated (investing, not exiting)
- Entity that's actively acquiring (not disposing)
- Trust created for asset protection, not transition
- Out-of-state owner with active rental income and property manager

STEP 6: GENERATE OUTPUT

CRITICAL LANGUAGE RULES:
- For SOURCED sections (name, occupation, facts, contact info): State directly. "Real Estate Agent at The Agency Bozeman."
- For INFERRED sections (how they think, seller psychology, decision style): Frame as hypothesis, not fact. Use "Likely prefers..." "Signals suggest..." "Based on property data, may..." "Pattern consistent with..." NEVER "They are..." or "Their communication style is..."
- For ADVISORY sections (approach, scripts, timing): Frame as recommendations. "Consider leading with..." "May respond well to..."
- This distinction is critical for user trust. Over-confident soft claims destroy credibility faster than missing data.

Return ONLY valid JSON:
{
  "name": "Full name of owner or principal",
  "address": "Full property address",
  "dataQuality": "Rich/Moderate/Limited",
  "segment": "One of: Never-Listed Legacy | Long-Term Owner | Investor/Entity | Luxury/High-End | Overlooked Transition",
  "segmentReasoning": "1-2 sentences on why this segment was chosen",
  "score": 0-100,
  "scoreLabel": "Very High/High/Moderate/Low/Unlikely",
  "scoreBasis": "2-3 sentences explaining what confirmed and inferred factors drove this score",
  "timeframe": "0-3 months / 3-6 months / 6-12 months / 12-24 months / 24+ months",
  "timeframeReasoning": "Why this timeframe",
  "motivationCategory": "Estate Transition / Equity Harvest / Portfolio Simplification / Life-Stage Change / Financial Pressure / Operational Burden / Representation Mismatch / Legacy Relief / Unknown",
  "offMarketScore": 0-100,
  "offMarketReasoning": "Why they would or wouldn't prefer off-market",
  "confidenceScore": 0-100,
  "confidenceReasoning": "How much data supports this assessment",
  "redFlags": ["Any reasons this owner may look like a seller but probably isn't"],
  "metrics": {
    "countyAssessedValue": "$XXX,XXX — directly from county tax records",
    "estimatedMarketValue": "$XXX,XXX from listing sites, OR 'Insufficient parcel-specific evidence' if comps don't match property type. NEVER invent a number from wrong comp type.",
    "estimatedMarketValueRange": "$X-$Y if range available, or null",
    "marketValueConfidence": "High/Medium/Low",
    "marketValueMethod": "Zillow estimate / Redfin estimate / listing history / land comp model / comparable lot sales / Not found",
    "valuationBlockedReason": "If market value cannot be reliably estimated, explain why (e.g., 'Only residential comps available for vacant land parcel', 'Thin comp market for luxury acreage'). Null if value was produced.",
    "estimatedEquity": "$XXX,XXX or range",
    "ownedSince": "YYYY",
    "ageRange": "XX-XX"
  },
  "confirmedFacts": ["Each key fact with source"],
  "contactInfo": {
    "phones": ["All phone numbers found"],
    "emails": ["All email addresses found"],
    "relatives": ["Names of relatives/associates"]
  },
  "entityInfo": {
    "entityName": "Entity name or null",
    "registeredAgent": "Name and address or null",
    "registeredAgentRole": "Attorney/Filing Service/Individual",
    "members": ["Identified principals"],
    "filingDate": "Date or null",
    "status": "Active/Inactive or null"
  },
  "whoTheyAre": {
    "spouse": "Name or Not found",
    "occupation": "Title at Company or inferred",
    "ownership": "How title is held",
    "decisionStyle": "Assessment based on segment and evidence"
  },
  "sellerPsychology": {
    "motivations": "What would realistically trigger a sale — frame as possibilities: 'Likely motivated by...' or 'Signals suggest...'",
    "hesitations": "What likely holds them back — frame as: 'Common concerns for this profile include...'",
    "offMarketPreference": "Why they might choose discreet sale — frame as likelihood: 'Pattern suggests preference for...'",
    "decisionProcess": "Likely decision dynamics — frame as: 'Based on ownership pattern, probable that...'",
    "triggerEvents": "Events that would move them to action — frame as scenarios: 'Would likely accelerate if...'"
  },
  "howTheyThink": {
    "financialMindset": "Use 'Signals suggest...' or 'Pattern consistent with...' framing — NEVER 'They are...'",
    "communication": "Use 'May prefer...' or 'Likely responds to...' framing",
    "socialPosition": "Use 'Context suggests...' framing based on property and public data",
    "bestChannel": "Use 'Consider...' framing with reasoning"
  },
  "wealthIndicators": {
    "incomeLevel": "Based on property + career evidence",
    "netWorthEstimate": "Range with reasoning",
    "evidence": ["Wealth signals found or inferred"],
    "financialSophistication": "Low/Medium/High with reasoning"
  },
  "signals": [{"text": "Signal description", "type": "positive/negative/neutral", "confidence": "Confirmed/Inferred"}],
  "approach": {
    "angle": "The primary outreach angle: convenience/certainty/privacy/speed/estate support/portfolio simplification/legacy relief/premium discreet execution/problem-solving",
    "opening": "Segment-specific personalized opening",
    "keyMessages": "What to emphasize based on their psychology and motivation",
    "avoid": "What NOT to say — specific to this segment and owner",
    "timing": "When and how often to reach out based on timeframe assessment",
    "whyOffMarket": "The specific sentence to use explaining why a direct/discreet approach benefits THEM"
  },
  "scripts": {
    "letter": "Full personalized letter using segment-appropriate tone and angle. [AGENT_NAME] [AGENT_PHONE] placeholders. Reference confirmed facts. A script that could apply to anyone is worthless.",
    "phone": "Full phone script with segment-appropriate opening and pivot points",
    "door": "Full door knock script appropriate to segment (e.g., different for ranch vs luxury condo vs estate)",
    "email": "Subject line then full body, segment-appropriate tone"
  }
}`;
}

// ===================
// MARKET SIGNALS — Area-level listing activity for briefing enrichment
// ===================
app.get('/api/market-signals', async (req, res) => {
  const city = req.query.city || '';
  const state = req.query.state || '';
  const zip = req.query.zip || '';
  
  if (!city && !zip) {
    return res.status(400).json({ error: 'City or zip required' });
  }
  
  const location = zip || `${city} ${state}`;
  console.log(`Market Signals: ${location}`);
  const startTime = Date.now();
  
  try {
    const searches = [
      { label: 'Zillow Off Market', query: `site:zillow.com "${city}" ${state} "off market" OR "removed"` },
      { label: 'Redfin Sold', query: `site:redfin.com "${city}" ${state} "sold" OR "pending"` },
      { label: 'Expired Listings', query: `"${city}" ${state} expired listing OR "removed from market" OR "withdrawn" OR "terminated" 2025 OR 2026` },
      { label: 'Price Reduced', query: `site:zillow.com "${city}" ${state} "price cut" OR "price drop" OR "reduced"` },
      { label: 'Zillow Recent Sales', query: `site:zillow.com "${city}" ${state} "sold" "2025" OR "2026"` },
      { label: 'Realtor Sold', query: `site:realtor.com "${city}" ${state} "recently sold" OR "just sold"` },
      { label: 'FSBO', query: `"${city}" ${state} "for sale by owner" OR "FSBO" 2025 OR 2026` },
      { label: 'Foreclosure', query: `"${city}" ${state} "pre-foreclosure" OR "foreclosure" OR "auction" 2025 OR 2026` },
    ];
    
    const results = await searchBatch(searches);
    
    // Extract addresses and signal types from search results
    const signals = [];
    const addrRegex = /(\d{1,6}\s+[A-Z0-9][A-Za-z0-9\s\.]{3,40}(?:St|Ave|Rd|Dr|Ln|Way|Blvd|Ct|Pl|Cir|Ter|Trl|Loop|Pkwy|Hwy))/gi;
    
    for (const [label, items] of Object.entries(results)) {
      if (!items || items.length === 0) continue;
      
      let signalType = 'market_activity';
      let signalWeight = 5;
      let signalText = 'Market activity detected';
      
      if (label.includes('Off Market') || label.includes('Expired')) {
        signalType = 'expired_withdrawn';
        signalWeight = 20;
        signalText = 'Expired or withdrawn listing';
      } else if (label.includes('Price Reduced')) {
        signalType = 'price_reduced';
        signalWeight = 12;
        signalText = 'Price reduction detected';
      } else if (label.includes('Sold') || label.includes('Recent Sales')) {
        signalType = 'recently_sold';
        signalWeight = 8;
        signalText = 'Recent sale — comp activity nearby';
      } else if (label.includes('FSBO')) {
        signalType = 'fsbo';
        signalWeight = 18;
        signalText = 'For sale by owner — no agent representation';
      } else if (label.includes('Foreclosure')) {
        signalType = 'foreclosure';
        signalWeight = 15;
        signalText = 'Pre-foreclosure or distress signal';
      }
      
      for (const item of items) {
        const text = `${item.title || ''} ${item.snippet || ''}`;
        const addrs = text.match(addrRegex) || [];
        
        for (const addr of addrs) {
          const cleaned = addr.trim().toUpperCase().replace(/\s+/g, ' ');
          // Avoid duplicate addresses
          if (!signals.find(s => s.address === cleaned && s.type === signalType)) {
            signals.push({
              address: cleaned,
              type: signalType,
              weight: signalWeight,
              text: signalText,
              source: label,
              snippet: (item.snippet || '').substring(0, 150)
            });
          }
        }
      }
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  Market Signals: ${searches.length} searches in ${elapsed}s — ${signals.length} address-level signals found`);
    
    res.json({ signals, location, searchCount: searches.length, elapsed });
    
  } catch(err) {
    console.error('Market signals error:', err);
    res.status(500).json({ error: 'Failed to fetch market signals' });
  }
});

// ===================
// CONSUMER LEAD CAPTURE — from gated map landing page
// ===================
app.post('/api/consumer-lead', async (req, res) => {
  try {
    const { name, address, email, phone, timestamp, clickHistory } = req.body;
    if (!name || !address) {
      return res.status(400).json({ error: 'Name and address required' });
    }
    
    console.log(`Consumer Lead: ${name} | ${address} | ${email} | ${phone} | Clicks: ${(clickHistory||[]).length}`);
    
    // Store in Supabase
    try {
      await supabase.from('consumer_leads').insert({
        name,
        address,
        email: email || null,
        phone: phone || null,
        click_history: clickHistory || [],
        source: 'map_gate',
        created_at: timestamp || new Date().toISOString()
      });
    } catch(dbErr) {
      console.log('Lead DB insert failed (table may not exist yet):', dbErr.message);
    }
    
    res.json({ success: true, message: 'Lead captured' });
  } catch(err) {
    console.error('Consumer lead error:', err);
    res.status(500).json({ error: 'Failed to capture lead' });
  }
});

// ===================
// BETA DEEP SIGNAL v2 — No auth, rate limited, parallel research
// ===================
const betaDailyLimit = { count: 0, resetTime: Date.now() + 86400000 };

app.post('/api/beta-research', async (req, res) => {
  // CORS for standalone HTML
  res.header('Access-Control-Allow-Origin', '*');
  
  // Reset daily counter
  if (Date.now() > betaDailyLimit.resetTime) {
    betaDailyLimit.count = 0;
    betaDailyLimit.resetTime = Date.now() + 86400000;
  }
  if (betaDailyLimit.count >= 20) {
    return res.status(429).json({ error: 'Daily beta limit reached (20 searches). Resets at midnight.' });
  }

  try {
    const { ownerName, propertyAddress, preliminaryScore } = req.body;
    const assessedValue = Number(req.body.assessedValue || 0);
    const buildingValue = Number(req.body.buildingValue || 0);
    const landValue = Number(req.body.landValue || 0);
    const propType = req.body.propType || '';
    
    // Valuation routing flags
    const isVacantLand = buildingValue === 0 || /vacant|land/i.test(propType);
    const isLuxuryAcreage = assessedValue > 500000 && landValue > assessedValue * 0.6;
    const isImprovedResidential = buildingValue > 0 && !isLuxuryAcreage;
    if (!propertyAddress) {
      return res.status(400).json({ error: 'Property address required' });
    }

    const addressParts = propertyAddress.split(',').map(s => s.trim());
    const streetAddress = addressParts[0] || '';
    const city = addressParts[1] || '';
    const stateZip = addressParts[2] || '';
    const state = stateZip.split(' ')[0] || '';

    const searchName = ownerName || streetAddress;
    
    // Check cache
    const cached = await getFromCache(searchName, propertyAddress);
    if (cached) return res.json(cached);

    console.log(`Beta Deep Signal v2: ${searchName} at ${propertyAddress}`);
    betaDailyLimit.count++;

    // If no owner name, try to resolve it
    let resolvedOwner = ownerName;
    if (!resolvedOwner || resolvedOwner === 'Owner Redacted' || resolvedOwner === '') {
      console.log('  Resolving owner name from address...');
      const ownerLookup = await searchBatch([
        { label: 'Owner Lookup', query: `"${streetAddress}" "${city}" ${state} property owner name` },
        { label: 'Tax Records', query: `"${streetAddress}" "${city}" ${state} tax records owner taxpayer` },
      ]);
      const lookupText = Object.entries(ownerLookup)
        .map(([l, r]) => `[${l}]\n${r.map(x => `${x.title} — ${x.snippet}`).join('\n')}`)
        .join('\n\n');

      if (lookupText.length > 50) {
        try {
          const nameExtract = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 100,
            temperature: 0,
            messages: [{ role: 'user', content: `Extract the property owner's full name from these search results for ${streetAddress}, ${city}, ${state}. Return ONLY the name as plain text, nothing else. If not found, return "Not found".\n\n${lookupText}` }]
          });
          const extracted = (nameExtract.content[0]?.text || '').trim();
          if (extracted && extracted !== 'Not found' && extracted.length > 2 && extracted.length < 80) {
            resolvedOwner = extracted;
            console.log(`  Resolved: ${resolvedOwner}`);
          }
        } catch (e) { console.log('  Name extraction failed:', e.message); }
      }
    }

    // Run parallel layered research
    const layers = await gatherSearchResultsV2(resolvedOwner || streetAddress, streetAddress, city, state);
    let formattedResults = formatLayeredResults(layers);
    
    // TWO-PASS ENTITY RESOLUTION
    // If the owner is an entity, try to extract the principal from first-pass results
    // then run person-specific searches on that individual
    const isEntity = /LLC|TRUST|LTD|PARTNERSHIP|INC|CORP|ESTATE|FOUNDATION|HOLDINGS|COMPANY|GROUP|RANCH|FARM|PROPERTIES|INVESTMENTS|ASSOCIATES|VENTURES|ENTERPRISES|PARTNERS|DEVELOPMENT|DEVELOPERS|REALTY|MANAGEMENT/i.test(resolvedOwner || ownerName);
    let resolvedPrincipal = null;
    
    if (isEntity) {
      console.log('  Entity detected — extracting principal for second-pass research...');
      try {
        const principalExtract = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 150,
          temperature: 0,
          messages: [{ role: 'user', content: `From these search results about "${resolvedOwner || ownerName}", extract the name of the actual human person who is the principal, member, manager, registered agent, or key individual behind this entity. Return ONLY the person's full name as plain text. If a registered agent is clearly a law firm or filing service, try to find an actual member or principal instead. If no individual can be identified, return "Not found".\n\n${formattedResults.substring(0, 4000)}` }]
        });
        const principal = (principalExtract.content[0]?.text || '').trim();
        if (principal && principal !== 'Not found' && principal.length > 3 && principal.length < 80 && !/LLC|INC|CORP|LAW|FIRM|SERVICE/i.test(principal)) {
          resolvedPrincipal = principal;
          console.log(`  Principal identified: ${resolvedPrincipal} — running person searches...`);
          
          // Second pass — search the actual person
          const personSearches = await searchBatch([
            { label: 'Principal LinkedIn', query: `"${resolvedPrincipal}" ${city} ${state} site:linkedin.com` },
            { label: 'Principal People Search', query: `"${resolvedPrincipal}" ${city} site:fastpeoplesearch.com` },
            { label: 'Principal WhitePages', query: `"${resolvedPrincipal}" ${city} ${state} site:whitepages.com` },
            { label: 'Principal Spokeo', query: `"${resolvedPrincipal}" ${city} site:spokeo.com` },
            { label: 'Principal Professional', query: `"${resolvedPrincipal}" ${city} ${state} career employer work` },
            { label: 'Principal News', query: `"${resolvedPrincipal}" ${city} ${state} news article` },
            { label: 'Principal Phone', query: `"${resolvedPrincipal}" ${city} ${state} phone email contact` },
            { label: 'Principal Facebook', query: `"${resolvedPrincipal}" ${city} ${state} site:facebook.com` },
          ]);
          
          // Append second-pass results to the formatted output
          formattedResults += '\n=== PRINCIPAL/MEMBER RESEARCH (Second Pass) ===\n';
          formattedResults += `Identified principal behind ${resolvedOwner || ownerName}: ${resolvedPrincipal}\n\n`;
          for (const [label, results] of Object.entries(personSearches)) {
            formattedResults += `[${label}]\n`;
            if (results.length === 0) formattedResults += 'No results\n';
            else for (const r of results) formattedResults += `• ${r.title}\n  ${r.snippet || ''}\n  ${r.link}\n`;
            formattedResults += '\n';
          }
          
          const personNonEmpty = Object.values(personSearches).filter(r => r.length > 0).length;
          console.log(`  Principal searches: ${personNonEmpty} of 8 returned results`);
        }
      } catch (e) { console.log('  Principal extraction failed:', e.message); }
    }
    
    // Normalize name for Claude prompt
    const normalizedForPrompt = normalizeOwnerName(resolvedPrincipal || resolvedOwner || streetAddress);
    const displayName = typeof normalizedForPrompt === 'object' ? normalizedForPrompt.searchPrimary : (resolvedPrincipal || resolvedOwner || streetAddress);

    const systemPrompt = buildDeepSignalPrompt(propertyAddress, preliminaryScore, city);


    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `Research subject: "${displayName}" at "${propertyAddress}"
${isEntity ? `Entity owner: ${resolvedOwner || ownerName}` : ''}
${resolvedPrincipal ? `Identified principal/member: ${resolvedPrincipal}` : ''}
Property location for all scripts and market references: ${propertyAddress}
Preliminary score from parcel data: ${preliminaryScore || 35}
County assessed value (TAX BASIS ONLY): ${assessedValue ? '$' + assessedValue.toLocaleString() : 'Unknown'}
County building value: ${buildingValue ? '$' + buildingValue.toLocaleString() : '$0'}
County land value: ${landValue ? '$' + landValue.toLocaleString() : 'Unknown'}
Property type: ${propType || 'Unknown'}

VALUATION ROUTING CONSTRAINTS:
${isVacantLand ? `THIS IS VACANT LAND (building value is zero). STRICT RULES:
- Do NOT use residential home comps, Zestimates, or nearby house sale prices as market value
- ONLY use lot/land-specific comps, subdivision land sales, or land listings for estimatedMarketValue
- If only generic neighborhood residential sales are available, set estimatedMarketValue to "Insufficient parcel-specific land comp evidence" and marketValueConfidence to "Low"
- Owner profession, income, or wealth must NEVER influence the land value estimate` : ''}
${isLuxuryAcreage ? `THIS IS LUXURY/ACREAGE PROPERTY. Standard AVMs are unreliable. Use listing-site estimates cautiously. Prefer comparable acreage/luxury sales evidence. Widen confidence band.` : ''}
${isImprovedResidential ? `This is improved residential property. Zillow/Redfin/Realtor estimates are acceptable for estimatedMarketValue.` : ''}
Owner profession, income, business ownership, or reputation must NEVER influence the estimatedMarketValue field.

${formattedResults}

Generate the Deep Signal report. Use Zillow/Redfin/Realtor estimates for market value — NEVER use assessed value as market value. Reference the ${city || 'local'} market in all scripts.`
      }],
      system: systemPrompt
    });

    let textContent = '';
    for (const block of response.content) {
      if (block.type === 'text') textContent += block.text;
    }

    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse response');
    const result = JSON.parse(jsonMatch[0]);

    // Cache
    await saveToCache(searchName, propertyAddress, result);
    res.json(result);
  } catch (error) {
    console.error('Beta research error:', error);
    res.status(500).json({ error: error.message || 'Research failed' });
  }
});

// CORS preflight for beta endpoint
app.options('/api/beta-research', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

// ===================
// SSE STREAMING DEEP SIGNAL — Same logic, real-time progress
// ===================
app.get('/api/beta-research/stream', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Content-Type', 'text/event-stream');
  res.header('Cache-Control', 'no-cache');
  res.header('Connection', 'keep-alive');
  res.flushHeaders();

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Reset daily counter
  if (Date.now() > betaDailyLimit.resetTime) {
    betaDailyLimit.count = 0;
    betaDailyLimit.resetTime = Date.now() + 86400000;
  }
  if (betaDailyLimit.count >= 20) {
    send('error', { error: 'Daily beta limit reached (20 searches).' });
    return res.end();
  }

  try {
    const ownerName = req.query.owner || '';
    const propertyAddress = req.query.address || '';
    const preliminaryScore = parseInt(req.query.score) || 35;
    const assessedValue = parseInt(req.query.assessed) || 0;
    const buildingValue = parseInt(req.query.building) || 0;
    const landValue = parseInt(req.query.land) || 0;
    const propType = req.query.propType || '';
    
    // Valuation routing flags
    const isVacantLand = buildingValue === 0 || /vacant|land/i.test(propType);
    const isLuxuryAcreage = assessedValue > 500000 && landValue > assessedValue * 0.6;
    const isImprovedResidential = buildingValue > 0 && !isLuxuryAcreage;
    
    if (!propertyAddress) {
      send('error', { error: 'Property address required' });
      return res.end();
    }

    const addressParts = propertyAddress.split(',').map(s => s.trim());
    const streetAddress = addressParts[0] || '';
    const city = addressParts[1] || '';
    const stateZip = addressParts[2] || '';
    const state = stateZip.split(' ')[0] || '';

    const searchName = ownerName || streetAddress;

    // Check cache
    const cached = await getFromCache(searchName, propertyAddress);
    if (cached) {
      send('progress', { stage: 'complete', message: 'Loaded from cache' });
      send('result', cached);
      return res.end();
    }

    console.log(`SSE Deep Signal: ${searchName} at ${propertyAddress}`);
    betaDailyLimit.count++;

    send('progress', { stage: 'init', message: 'Initializing research engine...' });

    // Resolve owner name if needed
    let resolvedOwner = ownerName;
    if (!resolvedOwner || resolvedOwner === 'Owner Redacted' || resolvedOwner === '') {
      send('progress', { stage: 'owner', message: 'Resolving property owner...' });
      const ownerLookup = await searchBatch([
        { label: 'Owner Lookup', query: `"${streetAddress}" "${city}" ${state} property owner name` },
        { label: 'Tax Records', query: `"${streetAddress}" "${city}" ${state} tax records owner taxpayer` },
      ]);
      const lookupText = Object.entries(ownerLookup)
        .map(([l, r]) => `[${l}]\n${r.map(x => `${x.title} — ${x.snippet}`).join('\n')}`)
        .join('\n\n');

      if (lookupText.length > 50) {
        try {
          const nameExtract = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 100,
            temperature: 0,
            messages: [{ role: 'user', content: `Extract the property owner's full name from these search results for ${streetAddress}, ${city}, ${state}. Return ONLY the name as plain text, nothing else. If not found, return "Not found".\n\n${lookupText}` }]
          });
          const extracted = (nameExtract.content[0]?.text || '').trim();
          if (extracted && extracted !== 'Not found' && extracted.length > 2 && extracted.length < 80) {
            resolvedOwner = extracted;
            send('progress', { stage: 'owner', message: `Owner identified: ${resolvedOwner}` });
          }
        } catch (e) { /* ignore */ }
      }
    } else {
      const normalized = normalizeOwnerName(resolvedOwner);
      const displayOwner = typeof normalized === 'object' ? normalized.searchPrimary : resolvedOwner;
      send('progress', { stage: 'owner', message: `Researching ${displayOwner}...` });
    }

    // Run searches with progress
    send('progress', { stage: 'searching', message: 'Searching property records, LinkedIn, public data...', searchesComplete: 0, searchesTotal: 40 });
    
    const layers = await gatherSearchResultsV2(resolvedOwner || streetAddress, streetAddress, city, state);
    let formattedResults = formatLayeredResults(layers);

    // Count results for display
    const allResults = { ...layers.propertyResults, ...layers.ownerResults, ...layers.intentResults, ...layers.connectionResults };
    const nonEmpty = Object.values(allResults).filter(r => r.length > 0).length;
    const totalItems = Object.values(allResults).reduce((sum, r) => sum + r.length, 0);
    
    send('progress', { stage: 'searched', message: `${nonEmpty} sources returned ${totalItems} results`, searchesComplete: 40, searchesTotal: 40 });

    // Property data preview — send early findings
    const earlyFacts = [];
    for (const [label, results] of Object.entries(layers.propertyResults || {})) {
      for (const r of results) {
        if (r.snippet && (r.snippet.includes('$') || r.snippet.includes('bed') || r.snippet.includes('sqft'))) {
          earlyFacts.push(r.snippet.substring(0, 120));
          break;
        }
      }
    }
    if (earlyFacts.length > 0) {
      send('preview', { facts: earlyFacts });
    }

    // Entity resolution
    const isEntity = /LLC|TRUST|LTD|PARTNERSHIP|INC|CORP|ESTATE|FOUNDATION|HOLDINGS|COMPANY|GROUP|RANCH|FARM|PROPERTIES|INVESTMENTS|ASSOCIATES|VENTURES|ENTERPRISES|PARTNERS|DEVELOPMENT|DEVELOPERS|REALTY|MANAGEMENT/i.test(resolvedOwner || ownerName);
    let resolvedPrincipal = null;

    if (isEntity) {
      send('progress', { stage: 'entity', message: 'Entity detected — identifying principal...' });
      try {
        const principalExtract = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 150,
          temperature: 0,
          messages: [{ role: 'user', content: `From these search results about "${resolvedOwner || ownerName}", extract the name of the actual human person who is the principal, member, manager, registered agent, or key individual behind this entity. Return ONLY the person's full name as plain text. If a registered agent is clearly a law firm or filing service, try to find an actual member or principal instead. If no individual can be identified, return "Not found".\n\n${formattedResults.substring(0, 4000)}` }]
        });
        const principal = (principalExtract.content[0]?.text || '').trim();
        if (principal && principal !== 'Not found' && principal.length > 3 && principal.length < 80 && !/LLC|INC|CORP|LAW|FIRM|SERVICE/i.test(principal)) {
          resolvedPrincipal = principal;
          send('progress', { stage: 'entity', message: `Principal identified: ${resolvedPrincipal} — researching...` });

          const personSearches = await searchBatch([
            { label: 'Principal LinkedIn', query: `"${resolvedPrincipal}" ${city} ${state} site:linkedin.com` },
            { label: 'Principal People Search', query: `"${resolvedPrincipal}" ${city} site:fastpeoplesearch.com` },
            { label: 'Principal WhitePages', query: `"${resolvedPrincipal}" ${city} ${state} site:whitepages.com` },
            { label: 'Principal Spokeo', query: `"${resolvedPrincipal}" ${city} site:spokeo.com` },
            { label: 'Principal Professional', query: `"${resolvedPrincipal}" ${city} ${state} career employer work` },
            { label: 'Principal News', query: `"${resolvedPrincipal}" ${city} ${state} news article` },
            { label: 'Principal Phone', query: `"${resolvedPrincipal}" ${city} ${state} phone email contact` },
            { label: 'Principal Facebook', query: `"${resolvedPrincipal}" ${city} ${state} site:facebook.com` },
          ]);

          formattedResults += '\n=== PRINCIPAL/MEMBER RESEARCH (Second Pass) ===\n';
          formattedResults += `Identified principal behind ${resolvedOwner || ownerName}: ${resolvedPrincipal}\n\n`;
          for (const [label, results] of Object.entries(personSearches)) {
            formattedResults += `[${label}]\n`;
            if (results.length === 0) formattedResults += 'No results\n';
            else for (const r of results) formattedResults += `• ${r.title}\n  ${r.snippet || ''}\n  ${r.link}\n`;
            formattedResults += '\n';
          }
        }
      } catch (e) { /* ignore */ }
    }

    // Claude analysis
    send('progress', { stage: 'analyzing', message: 'AI analyzing findings and building profile...' });

    // Keepalive pings every 5s to prevent Railway/browser timeout during Claude analysis
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch(e) { clearInterval(keepalive); }
    }, 5000);

    const normalizedForPrompt = normalizeOwnerName(resolvedPrincipal || resolvedOwner || streetAddress);
    const displayName = typeof normalizedForPrompt === 'object' ? normalizedForPrompt.searchPrimary : (resolvedPrincipal || resolvedOwner || streetAddress);

    const systemPrompt = buildDeepSignalPrompt(propertyAddress, preliminaryScore, city);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `Research subject: "${displayName}" at "${propertyAddress}"
${isEntity ? `Entity owner: ${resolvedOwner || ownerName}` : ''}
${resolvedPrincipal ? `Identified principal/member: ${resolvedPrincipal}` : ''}
Property location for all scripts and market references: ${propertyAddress}
Preliminary score from parcel data: ${preliminaryScore || 35}
County assessed value (TAX BASIS ONLY): ${assessedValue ? '$' + Number(assessedValue).toLocaleString() : 'Unknown'}
County building value: ${buildingValue ? '$' + Number(buildingValue).toLocaleString() : '$0'}
County land value: ${landValue ? '$' + Number(landValue).toLocaleString() : 'Unknown'}
Property type: ${propType || 'Unknown'}

VALUATION ROUTING CONSTRAINTS:
${isVacantLand ? `THIS IS VACANT LAND (building value is zero). STRICT RULES:
- Do NOT use residential home comps, Zestimates, or nearby house sale prices as market value
- ONLY use lot/land-specific comps, subdivision land sales, or land listings for estimatedMarketValue
- If only generic neighborhood residential sales are available, set estimatedMarketValue to "Insufficient parcel-specific land comp evidence" and marketValueConfidence to "Low"
- Owner profession, income, or wealth must NEVER influence the land value estimate
- Price-per-acre or price-per-lot logic is acceptable` : ''}
${isLuxuryAcreage ? `THIS IS LUXURY/ACREAGE PROPERTY. Standard AVMs are unreliable. Use listing-site estimates cautiously. Prefer comparable acreage/luxury sales evidence. Widen confidence band.` : ''}
${isImprovedResidential ? `This is improved residential property. Zillow/Redfin/Realtor estimates are acceptable for estimatedMarketValue.` : ''}
Owner profession, income, business ownership, or reputation must NEVER influence the estimatedMarketValue field. Those belong in the seller psychology and outreach sections only.

${formattedResults}

Generate the Deep Signal report. Use Zillow/Redfin/Realtor estimates for market value — NEVER use assessed value as market value. Reference the ${city || 'local'} market in all scripts.`
      }],
      system: systemPrompt
    });

    clearInterval(keepalive);

    let textContent = '';
    for (const block of response.content) {
      if (block.type === 'text') textContent += block.text;
    }

    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse response');
    const result = JSON.parse(jsonMatch[0]);

    send('progress', { stage: 'complete', message: 'Deep Signal complete' });
    send('result', result);

    await saveToCache(searchName, propertyAddress, result);
  } catch (error) {
    console.error('SSE research error:', error);
    send('error', { error: error.message || 'Research failed' });
  }
  res.end();
});

// ===================
// FIND SELLERS - Montana Cadastral Integration
// ===================

// Geocode an address to lat/lng using Nominatim (free, no API key)
async function geocodeAddress(address) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'SellerSignal/1.0 (contact@sellersignal.co)' }
    });
    const data = await response.json();
    
    if (data && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
        display: data[0].display_name
      };
    }
    return null;
  } catch (error) {
    console.error('Geocoding error:', error.message);
    return null;
  }
}

// Query Montana Cadastral ArcGIS REST API for nearby parcels
async function queryMontanaParcels(lat, lng, radiusMeters = 250) {
  try {
    const url = `https://gisservicemt.gov/arcgis/rest/services/MSDI_Framework/Parcels/MapServer/0/query`;
    const params = new URLSearchParams({
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      distance: radiusMeters.toString(),
      units: 'esriSRUnit_Meter',
      outFields: 'OwnerName,AddressLine1,AddressLine2,CityStateZip,PropAccess,TotalValue,TotalBuildingValue,TotalLandValue,PropType,GISAcres,Subdivision,OwnerAddress1,OwnerAddress2,OwnerCity,OwnerState,OwnerZipCode,PARCELID',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'json',
      resultRecordCount: '25'
    });

    const response = await fetch(`${url}?${params}`);
    const data = await response.json();
    
    if (data.error) {
      console.error('Cadastral API error:', data.error);
      return [];
    }

    return (data.features || []).map(f => {
      const a = f.attributes;
      // Calculate centroid from geometry
      let centroidLat = lat, centroidLng = lng;
      if (f.geometry && f.geometry.rings && f.geometry.rings[0]) {
        const ring = f.geometry.rings[0];
        centroidLng = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
        centroidLat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
      }
      
      return {
        parcelId: a.PARCELID,
        ownerName: a.OwnerName,
        address: (a.AddressLine1 || '').trim(),
        addressLine2: (a.AddressLine2 || '').trim(),
        cityStateZip: (a.CityStateZip || '').trim(),
        propAccess: (a.PropAccess || '').trim(),
        totalValue: a.TotalValue || 0,
        buildingValue: a.TotalBuildingValue || 0,
        landValue: a.TotalLandValue || 0,
        propType: a.PropType || '',
        acres: a.GISAcres || 0,
        subdivision: a.Subdivision || '',
        ownerAddress: (a.OwnerAddress1 || '').trim(),
        ownerCity: (a.OwnerCity || '').trim(),
        ownerState: (a.OwnerState || '').trim(),
        ownerZip: (a.OwnerZipCode || '').trim(),
        lat: centroidLat,
        lng: centroidLng
      };
    });
  } catch (error) {
    console.error('Cadastral query error:', error.message);
    return [];
  }
}

// Calculate preliminary seller signals from parcel data alone
function calculateParcelSignals(parcel, allParcels) {
  const signals = [];
  let score = 35; // baseline

  // Filter to residential valued properties for comparison
  const valuedParcels = allParcels.filter(p => p.totalValue > 0 && p.propType !== 'Exempt Property' && p.propType !== 'Non-Valued Property');
  
  // 1. Absentee owner detection
  const propAddr = parcel.address.toLowerCase().replace(/\s+/g, '');
  const ownerAddr = parcel.ownerAddress.toLowerCase().replace(/\s+/g, '');
  
  if (ownerAddr && propAddr && !ownerAddr.includes(propAddr.substring(0, 10)) && propAddr.length > 5) {
    if (parcel.ownerState && parcel.ownerState.toUpperCase() !== 'MT') {
      signals.push({ text: `Out-of-state owner (${parcel.ownerState})`, type: 'positive', weight: 20 });
      score += 20;
    } else {
      signals.push({ text: 'Absentee owner', type: 'positive', weight: 12 });
      score += 12;
    }
  }

  // 2. Entity ownership
  const entityPatterns = /\bLLC\b|\bTRUST\b|\bLTD\b|\bPARTNERSHIP\b|\bINC\b|\bCORP\b|\bESTATE\b|\bREV TRUST\b|\bFAM\b.*\bTRUST\b/i;
  if (parcel.ownerName && entityPatterns.test(parcel.ownerName)) {
    if (/TRUST|ESTATE|REV TRUST/i.test(parcel.ownerName)) {
      signals.push({ text: 'Trust/Estate ownership', type: 'positive', weight: 15 });
      score += 15;
    } else {
      signals.push({ text: 'Entity ownership (LLC/Corp)', type: 'positive', weight: 10 });
      score += 10;
    }
  }

  // 3. Building-to-land value ratio
  if (parcel.totalValue > 0 && parcel.landValue > 0) {
    const landRatio = parcel.landValue / parcel.totalValue;
    if (landRatio > 0.65) {
      signals.push({ text: 'Land value exceeds building value', type: 'positive', weight: 8 });
      score += 8;
    }
  }

  // 4. Value outlier detection
  if (valuedParcels.length >= 3 && parcel.totalValue > 0) {
    const values = valuedParcels.map(p => p.totalValue).sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    
    if (parcel.totalValue < median * 0.6) {
      signals.push({ text: `Assessed below area median ($${(median/1000).toFixed(0)}K)`, type: 'positive', weight: 8 });
      score += 8;
    } else if (parcel.totalValue > median * 1.5) {
      signals.push({ text: 'Premium property for area', type: 'neutral', weight: 0 });
    }
  }

  // 5. Property type signals
  if (parcel.propType === 'Vacant Land') {
    signals.push({ text: 'Vacant land', type: 'neutral', weight: 5 });
    score += 5;
  } else if (parcel.propType === 'Apartment') {
    signals.push({ text: 'Multi-family/Apartment', type: 'neutral', weight: 3 });
    score += 3;
  }

  // Cap score at 95
  score = Math.min(95, Math.max(5, score));

  return { score, signals };
}

// Use Claude to do a batch analysis and refine rankings
async function analyzeParcelBatch(parcels, searchAddress) {
  const parcelSummaries = parcels.map((p, i) => {
    const signals = p._signals || [];
    const signalText = signals.map(s => s.text).join(', ') || 'None detected';
    return `${i+1}. ${p.ownerName || 'Unknown'} | ${p.address}, ${p.cityStateZip || ''} | Value: $${(p.totalValue || 0).toLocaleString()} (Building: $${(p.buildingValue || 0).toLocaleString()}, Land: $${(p.landValue || 0).toLocaleString()}) | Type: ${p.propType} | ${p.acres.toFixed(2)} acres | Subdivision: ${p.subdivision || 'N/A'} | Owner Mail: ${p.ownerAddress}, ${p.ownerCity} ${p.ownerState} ${p.ownerZip} | Preliminary Signals: ${signalText}`;
  }).join('\n');

  const prompt = `You are a real estate intelligence analyst. Analyze these ${parcels.length} properties near "${searchAddress}" and refine the seller likelihood scoring.

PROPERTIES:
${parcelSummaries}

For each property, provide:
1. An adjusted seller likelihood score (0-100) considering all available signals
2. A brief one-line insight explaining WHY this property ranks where it does — something an agent can immediately act on
3. The owner's likely profile type: "Individual", "Investor", "Trust/Estate", "Developer", or "Institution"

SCORING GUIDANCE:
- Absentee/out-of-state owners: strong sell signal (they may have already moved on)
- Trust/Estate ownership: often indicates generational transfer, possible liquidation
- LLC ownership: investors are transactional, always have a price
- Land value > building value: redevelopment opportunity, owners may be holding for the right offer  
- Long-time ownership in rapidly appreciating area: sitting on significant equity, may be ready to cash out
- Value significantly below neighbors: possible deferred maintenance, aging owner, or estate situation
- Exempt/non-valued/government: skip these, score 0

IMPORTANT: 
- Be direct and specific in insights. Not "may be interested in selling" — instead "Out-of-state LLC holding undervalued lot in hot subdivision — likely waiting for the right number"
- Skip properties with no owner name or exempt/government properties — give them score 0
- Focus on what makes each property ACTIONABLE for an agent

Return ONLY valid JSON array, no other text:
[
  {
    "index": 1,
    "score": 72,
    "insight": "One-line actionable insight",
    "ownerType": "Individual",
    "topSignal": "Primary signal label"
  }
]`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
      system: 'You are a real estate data analyst. Return only valid JSON arrays. No markdown, no explanation, no code fences.'
    });

    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
    }

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('Batch analysis error:', error.message);
    return null;
  }
}

// FIND SELLERS ENDPOINT
app.post('/api/find-sellers', async (req, res) => {
  try {
    const { address, radius } = req.body;

    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    // Auth check
    const user = await getUserFromToken(req.headers.authorization);
    if (!user) {
      return res.status(401).json({ error: 'Please sign in to use SellerSignal' });
    }

    // Rate limiting
    if (!checkRateLimit(user.id + '-find', 10, 60000)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
    }

    console.log(`Find Sellers: "${address}" (radius: ${radius || 250}m)`);

    // Step 1: Geocode the address
    const geo = await geocodeAddress(address);
    if (!geo) {
      return res.status(400).json({ error: 'Could not locate that address. Try including city and state.' });
    }

    console.log(`  Geocoded to: ${geo.lat}, ${geo.lng}`);

    // Step 2: Query Montana Cadastral
    const radiusMeters = Math.min(radius || 250, 500); // cap at 500m
    const parcels = await queryMontanaParcels(geo.lat, geo.lng, radiusMeters);

    if (parcels.length === 0) {
      return res.status(404).json({ error: 'No properties found near that address. This tool currently covers Montana.' });
    }

    console.log(`  Found ${parcels.length} parcels`);

    // Step 3: Filter out empty/exempt parcels and calculate preliminary signals
    const filtered = parcels.filter(p => 
      p.ownerName && 
      p.ownerName.trim() !== '' &&
      p.propType !== 'Exempt Property' &&
      p.propType !== 'Non-Valued Property'
    );

    // Calculate preliminary signals for each parcel
    for (const parcel of filtered) {
      const { score, signals } = calculateParcelSignals(parcel, filtered);
      parcel._prelimScore = score;
      parcel._signals = signals;
    }

    // Step 4: Run Claude batch analysis for refined scoring
    const analysis = await analyzeParcelBatch(filtered, address);

    // Step 5: Merge analysis with parcel data
    const results = filtered.map((parcel, i) => {
      const ai = analysis ? analysis.find(a => a.index === i + 1) : null;
      
      return {
        ownerName: parcel.ownerName,
        address: parcel.address,
        cityStateZip: parcel.cityStateZip,
        totalValue: parcel.totalValue,
        buildingValue: parcel.buildingValue,
        landValue: parcel.landValue,
        propType: parcel.propType,
        acres: parcel.acres,
        subdivision: parcel.subdivision,
        score: ai ? ai.score : parcel._prelimScore,
        insight: ai ? ai.insight : parcel._signals.map(s => s.text).join(' • ') || 'Standard residential property',
        ownerType: ai ? ai.ownerType : 'Individual',
        topSignal: ai ? ai.topSignal : (parcel._signals[0]?.text || 'No strong signals'),
        signals: parcel._signals,
        // Include for Deep Signal passthrough
        ownerAddress: parcel.ownerAddress,
        ownerCity: parcel.ownerCity,
        ownerState: parcel.ownerState,
        lat: parcel.lat,
        lng: parcel.lng
      };
    });

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    res.json({
      searchAddress: address,
      geocoded: geo.display,
      radius: radiusMeters,
      count: results.length,
      results: results
    });

  } catch (error) {
    console.error('Find Sellers error:', error);
    res.status(500).json({ error: error.message || 'Search failed' });
  }
});

// ===================
// CACHE MANAGEMENT
// ===================
app.get('/api/cache/clear', async (req, res) => {
  if (!supabase) return res.json({ status: 'No cache configured' });
  await supabase.from('signals_cache').delete().neq('cache_key', '');
  res.json({ status: 'Cache cleared' });
});

// ===================
// HEALTH CHECK
// ===================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    supabase: !!supabase,
    stripe: !!stripe,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    serpapi: !!SERPAPI_KEY
  });
});

// ===================
// STATIC FILES
// ===================
app.get('/', (req, res) => res.sendFile('index.html', { root: './public' }));

// ===================
// START SERVER
// ===================
app.listen(PORT, () => {
  console.log(`SellerSignal running on port ${PORT}`);
  console.log(`Supabase: ${supabase ? 'connected' : 'not configured'}`);
  console.log(`Stripe: ${stripe ? 'connected' : 'not configured'}`);
  console.log(`SerpAPI: ${SERPAPI_KEY ? 'connected' : 'not configured'}`);
});
