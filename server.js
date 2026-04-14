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
  team: process.env.STRIPE_PRICE_TEAM || 'price_1StcI4LA5wV9TJQmWVYrPnwx',
  territory: process.env.STRIPE_PRICE_TERRITORY || null // $1000/mo per ZIP — create in Stripe dashboard
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
  if (!rawName) return { full: '', searchPrimary: '', first: '', last: '', original: '', isEntity: false };
  
  let name = rawName.trim();
  if (!name) return { full: '', searchPrimary: '', first: '', last: '', original: '', isEntity: false };
  
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
  if (businessWords.test(cleanName)) return { full: name, searchPrimary: name, first: '', last: '', original: name, isEntity: true };
  
  // If name contains numbers (like "CIRCLE 4 RANCH" or "123 HOLDINGS"), entity
  if (/\d/.test(cleanName)) return { full: name, searchPrimary: name, first: '', last: '', original: name, isEntity: true };
  
  // If only 1 word, probably an entity or nickname — pass through
  if (parts.length < 2) return { full: name, searchPrimary: name, first: '', last: name, original: name, isEntity: false };
  
  // If more than 3 words, probably an entity (people rarely have 4+ name parts in parcel data)
  if (parts.length > 3) return { full: name, searchPrimary: name, first: '', last: '', original: name, isEntity: true };
  
  // 2-3 words, all alphabetic, no business terms — this is a person
  // Check all parts are purely alpha (allowing periods and hyphens for initials/hyphenated names)
  const allAlpha = parts.every(p => /^[A-Za-z][A-Za-z.\-']*$/.test(p));
  if (!allAlpha) return { full: name, searchPrimary: name, first: '', last: '', original: name, isEntity: false };
  
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
    original: name,
    isEntity: false
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
  const searchName = normalized.searchPrimary;
  const fullName = normalized.full;
  const firstName = normalized.first;
  const lastName = normalized.last;
  const isEntity = normalized.isEntity || /LLC|TRUST|LTD|PARTNERSHIP|INC|CORP|ESTATE|FOUNDATION|HOLDINGS|COMPANY|GROUP|RANCH|FARM|PROPERTIES|INVESTMENTS|ASSOCIATES|VENTURES|ENTERPRISES|PARTNERS|DEVELOPMENT|DEVELOPERS|REALTY|MANAGEMENT/i.test(ownerName);
  
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
const DEEP_SIGNAL_VERSION = 'ds_v5'; // Bump when prompt or logic changes

function normalizeDeepSignalInput(req) {
  const ownerName = req.query.owner || req.body.owner || req.body.ownerName || '';
  const propertyAddress = req.query.address || req.body.address || req.body.propertyAddress || '';
  const preliminaryScore = Number(req.query.score || req.body.score || req.body.preliminaryScore || 35);
  const assessedValue = Number(req.query.assessed || req.body.assessed || req.body.assessedValue || 0);
  const buildingValue = Number(req.query.building || req.body.building || req.body.buildingValue || 0);
  const landValue = Number(req.query.land || req.body.land || req.body.landValue || 0);
  const propType = req.query.propType || req.body.propType || '';
  
  const isVacantLand = buildingValue === 0 || /vacant|land/i.test(propType);
  const isLuxuryAcreage = assessedValue > 500000 && landValue > assessedValue * 0.6;
  const isImprovedResidential = buildingValue > 0 && !isLuxuryAcreage;
  
  return { ownerName, propertyAddress, preliminaryScore, assessedValue, buildingValue, landValue, propType, isVacantLand, isLuxuryAcreage, isImprovedResidential };
}

function getCacheKey(ownerName, propertyAddress) {
  return `${ownerName.toLowerCase().trim()}|${propertyAddress.toLowerCase().trim()}|${DEEP_SIGNAL_VERSION}`;
}

// ===================================================================
// SANITIZE SIGNALS — strip hollow/fabricated signals before caching
// ===================================================================
// The LLM will sometimes generate signals that aren't real evidence:
//   - "No digital footprint" = absence of evidence, not positive signal
//   - "In gentrifying neighborhood" = macro-market fact, applies to all
//   - "Complete absence of owner data" = contradicts anything else
//   - "No recent listing history" = expected default, not a signal
// These patterns destroy user trust by manufacturing false confidence.
// This filter runs on every Deep Signal result before it hits the cache.
// ===================================================================
const HOLLOW_SIGNAL_PATTERNS = [
  // Absence-of-evidence patterns (most common failure mode)
  /no\s+digital\s+footprint/i,
  /no\s+online\s+presence/i,
  /no\s+public\s+records?/i,
  /no\s+recent\s+listing/i,
  /no\s+listing\s+history/i,
  /no\s+social\s+media/i,
  /no\s+search\s+results/i,
  /no\s+information\s+(available|found)/i,
  /limited\s+public\s+information/i,
  /minimal\s+online\s+presence/i,
  /not\s+found\s+in\s+search/i,
  /complete\s+absence\s+of/i,
  /absence\s+of\s+owner\s+data/i,
  /lack\s+of\s+(public|digital|online)/i,
  /unable\s+to\s+(find|locate|verify)/i,
  /cannot\s+(find|locate|verify)/i,
  /insufficient\s+data/i,
  // Macro-market observations (apply to entire neighborhood, not individual)
  /rapidly\s+gentrifying/i,
  /in\s+a?\s*gentrifying/i,
  /neighborhood\s+is\s+(gentrifying|appreciating|rising)/i,
  /property\s+in\s+.{0,30}(gentrifying|appreciating|booming|hot)/i,
  /market\s+is\s+(hot|appreciating|rising)/i,
  /area\s+property\s+values/i,
  /rising\s+property\s+values?\s+in/i,
  // Tautological "based on name format" claims
  /based\s+on\s+name\s+format/i,
  /individual\s+ownership\s+based\s+on/i,
  // Self-contradictory filler
  /based\s+on\s+limited\s+data/i,
  /based\s+on\s+available\s+information/i,
];

function isHollowSignal(signal) {
  if (!signal || typeof signal !== 'object') return true;
  const text = (signal.text || '').trim();
  if (!text || text.length < 5) return true;
  // Check against all hollow patterns
  for (const pattern of HOLLOW_SIGNAL_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function sanitizeDeepSignalResult(result) {
  if (!result || typeof result !== 'object') return result;
  
  // 1. Filter signals array — drop hollow entries
  if (Array.isArray(result.signals)) {
    const before = result.signals.length;
    result.signals = result.signals.filter(s => !isHollowSignal(s));
    const removed = before - result.signals.length;
    if (removed > 0) {
      console.log(`[sanitize] Stripped ${removed} hollow signals from Deep Signal result`);
    }
  }
  
  // 2. Filter confirmedFacts — drop tautological "owner name appears as X" entries
  if (Array.isArray(result.confirmedFacts)) {
    result.confirmedFacts = result.confirmedFacts.filter(f => {
      const text = (typeof f === 'string' ? f : (f.text || f.fact || '')).trim();
      if (!text) return false;
      // Drop "Owner name appears as X" — that's just restating the input
      if (/owner\s+name\s+appears\s+as/i.test(text)) return false;
      if (/based\s+on\s+name\s+format/i.test(text)) return false;
      return true;
    });
  }
  
  // 3. If sellerPsychology contains only generic hedges, null it out
  if (result.sellerPsychology && typeof result.sellerPsychology === 'object') {
    const psych = result.sellerPsychology;
    const isGenericHedge = (text) => {
      if (!text || text.length < 15) return true;
      // "May be motivated by rising property values" / "Privacy concerns likely create"
      // — these are boilerplate that apply to everyone
      const boilerplate = [
        /privacy\s+concerns\s+likely\s+create/i,
        /may\s+be\s+motivated\s+by\s+(rising|gentrifying|appreciation)/i,
        /long-term\s+resident\s+watching/i,
        /emotional\s+attachment\s+to\s+property\s+or\s+neighborhood/i,
        /continued\s+gentrification\s+and\s+rising/i,
      ];
      return boilerplate.some(p => p.test(text));
    };
    if (isGenericHedge(psych.motivations) && isGenericHedge(psych.hesitations)) {
      // Both sides are generic — kill the whole section
      result.sellerPsychology = null;
      console.log('[sanitize] Stripped generic sellerPsychology section');
    }
  }
  
  // 4. Mark the result as low-evidence if nothing real survived
  const hasRealSignals = Array.isArray(result.signals) && result.signals.length > 0;
  const hasRealFacts = Array.isArray(result.confirmedFacts) && result.confirmedFacts.length > 0;
  const hasPsych = result.sellerPsychology && (result.sellerPsychology.motivations || result.sellerPsychology.hesitations);
  
  if (!hasRealSignals && !hasRealFacts && !hasPsych) {
    result._lowEvidence = true;
    result.dataQuality = 'Limited';
  }
  
  return result;
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
  // Sanitize on read too — cleans old cached entries that were written before
  // the sanitizer existed. Safe to call on already-clean results (idempotent).
  return data?.result ? sanitizeDeepSignalResult(data.result) : null;
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
    const { ownerName, propertyAddress, parcelId } = req.body;
    
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

    // =====================================================================
    // CACHE-FIRST: Check deep_signals by parcelId before burning SerpAPI.
    // If the client supplied a parcelId and we have a cached grounded Deep
    // Signal from the batch pipeline, return it directly. This is the same
    // treatment applied to /api/beta-research. The legacy live-research
    // path below is retained for requests without a parcelId (manual
    // research flows, pre-batch parcels) but is still gated by the auth
    // check + per-user rate limit + daily signal limit above.
    // =====================================================================
    if (parcelId && supabase) {
      try {
        const { data: cachedDS } = await supabase
          .from('deep_signals')
          .select('*')
          .eq('parcel_id', parcelId)
          .maybeSingle();
        
        if (cachedDS && cachedDS.report) {
          const report = cachedDS.report || {};
          // Still count against user limit even on cache hit
          await incrementSignalCount(user.id);
          console.log(`[/api/research] cache HIT for parcel ${parcelId}`);
          return res.json({
            motivation: cachedDS.motivation || report.motivation || '',
            timeline: cachedDS.timeline || report.timeline || '',
            best_channel: cachedDS.best_channel || report.best_channel || '',
            call_script: cachedDS.call_script || report.call_script || '',
            mail_script: cachedDS.mail_script || report.mail_script || '',
            door_script: cachedDS.door_script || report.door_script || '',
            what_not_to_say: cachedDS.what_not_to_say || report.what_not_to_say || '',
            scripts: {
              letter: cachedDS.mail_script || '',
              phone: cachedDS.call_script || '',
              door: cachedDS.door_script || '',
              email: '',
              avoid: cachedDS.what_not_to_say || '',
            },
            _source: 'batch_cache',
            _generatedAt: cachedDS.generated_at,
            _researchGrounded: report.research_grounded === true,
          });
        }
      } catch (e) {
        console.error(`[/api/research] cache lookup failed for ${parcelId}:`, e.message);
        // Fall through to live path below
      }
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

    console.log(`Researching: ${ownerName} at ${propertyAddress} (LIVE - no parcelId or cache miss)`);

    // Parse address
    const addressParts = propertyAddress.split(',').map(s => s.trim());
    const streetAddress = addressParts[0] || '';
    const city = addressParts[1] || '';
    const stateZip = addressParts[2] || '';
    const state = stateZip.split(' ')[0] || '';

    // Gather search results — use the fast parallel tiered pipeline
    const searchLayers = await gatherSearchResultsV2(ownerName, streetAddress, city, state);
    const formattedResults = formatLayeredResults(searchLayers);

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
    
    // Strip hollow signals before caching — prevents false confidence on low-evidence prospects
    sanitizeDeepSignalResult(result);
    
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
// MY TERRITORIES (bypasses RLS via service role)
// ===================
const ADMIN_EMAILS = ['jeremy@sellersignal.co', 'jeremyseglem@gmail.com', 'jeremy.seglem@theagencyre.com', 'jmseglem@gmail.com', 'brian.hawkins@theagencyre.com'];

app.get('/api/my-territories', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  try {
    const isAdmin = ADMIN_EMAILS.includes(user.email?.toLowerCase());
    console.log(`[MY-TERRITORIES] isAdmin: ${isAdmin}, email check: "${user.email?.toLowerCase()}"`);
    
    let claims;
    if (isAdmin) {
      // Admins see all ZIPs that have briefing data — skip territory_claims entirely
      const { data: allBriefings, error } = await supabase.from('zip_briefings')
        .select('zip_code, market_key, total_parcels, act_today_count, outreach_queue_count, computed_at');
      if (error) throw error;
      // Synthesize claims from briefing data so dashboard can render cards
      claims = (allBriefings || []).map(b => ({
        zip_code: b.zip_code,
        status: 'active',
        agent_email: user.email,
        agent_name: 'Admin',
      }));
      let briefings = {};
      for (const b of (allBriefings || [])) briefings[b.zip_code] = b;
      return res.json({ claims, briefings, isAdmin: true });
    } else {
      const { data, error } = await supabase.from('territory_claims')
        .select('*')
        .eq('user_id', user.id)
        .in('status', ['active', 'trial', 'pending']);
      if (error) throw error;
      claims = data || [];
    }
    
    // Also fetch briefing stats for their ZIPs
    const zips = claims.map(c => c.zip_code);
    let briefings = {};
    if (zips.length > 0) {
      const { data: bData } = await supabase.from('zip_briefings')
        .select('zip_code, total_parcels, act_today_count, outreach_queue_count, computed_at')
        .in('zip_code', zips);
      for (const b of (bData || [])) briefings[b.zip_code] = b;
    }
    
    res.json({ claims, briefings, isAdmin });
  } catch(e) {
    console.error('My territories error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===================
// PREDICTION ACCURACY — admin endpoint to view validation stats
// ===================
app.get('/api/admin/accuracy', async (req, res) => {
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (!ADMIN_EMAILS.includes(user.email?.toLowerCase())) {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  try {
    // Overall stats
    const { data: allValidations, error: vErr } = await supabase
      .from('prediction_validations')
      .select('*');
    
    if (vErr) {
      return res.json({ 
        error: vErr.message, 
        hint: 'Tables may not exist yet. Run schema-prediction-tracking.sql in Supabase SQL Editor.',
        snapshots: 0,
        validations: 0
      });
    }
    
    const { count: snapshotCount } = await supabase
      .from('prediction_snapshots')
      .select('*', { count: 'exact', head: true });
    
    const validations = allValidations || [];
    const total = validations.length;
    const everActToday = validations.filter(v => v.ever_act_today).length;
    const within30 = validations.filter(v => v.days_from_first_flag != null && v.days_from_first_flag <= 30).length;
    const within60 = validations.filter(v => v.days_from_first_flag != null && v.days_from_first_flag <= 60).length;
    const within90 = validations.filter(v => v.days_from_first_flag != null && v.days_from_first_flag <= 90).length;
    const within180 = validations.filter(v => v.days_from_first_flag != null && v.days_from_first_flag <= 180).length;
    
    const avgDaysToSale = validations
      .filter(v => v.days_from_first_flag != null)
      .reduce((sum, v, _, arr) => sum + v.days_from_first_flag / arr.length, 0);
    
    // By market
    const byMarket = {};
    for (const v of validations) {
      const m = v.market_key || 'unknown';
      if (!byMarket[m]) byMarket[m] = { total: 0, actToday: 0, within90: 0 };
      byMarket[m].total++;
      if (v.ever_act_today) byMarket[m].actToday++;
      if (v.days_from_first_flag != null && v.days_from_first_flag <= 90) byMarket[m].within90++;
    }
    
    res.json({
      snapshots_total: snapshotCount || 0,
      validations_total: total,
      ever_act_today: everActToday,
      sold_within_30d: within30,
      sold_within_60d: within60,
      sold_within_90d: within90,
      sold_within_180d: within180,
      avg_days_to_sale: Math.round(avgDaysToSale * 10) / 10,
      pct_act_today_hit: total > 0 ? Math.round(everActToday / total * 1000) / 10 : 0,
      pct_within_90d: total > 0 ? Math.round(within90 / total * 1000) / 10 : 0,
      by_market: byMarket,
      recent_sales: validations.sort((a,b) => new Date(b.sale_date) - new Date(a.sale_date)).slice(0, 10),
    });
  } catch(e) {
    console.error('Accuracy endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
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
      
      // Handle territory claims
      if (session.metadata?.type === 'territory_claim') {
        const zips = (session.metadata.zipCodes || '').split(',').filter(Boolean);
        for (const zip of zips) {
          await supabase.from('territory_claims').upsert({
            zip_code: zip,
            status: 'active',
            stripe_subscription_id: session.subscription,
            agent_name: session.metadata.agentName,
            agent_email: session.metadata.agentEmail,
            agent_phone: session.metadata.agentPhone,
            agent_brokerage: session.metadata.agentBrokerage,
            claimed_at: new Date().toISOString(),
          }, { onConflict: 'zip_code', ignoreDuplicates: false });
          console.log(`Territory claimed: ZIP ${zip} by ${session.metadata.agentEmail}`);
        }
        break;
      }
      
      // Handle waitlist card setup
      if (session.metadata?.type === 'territory_waitlist') {
        const zip = session.metadata.zipCode;
        await supabase.from('territory_claims')
          .update({ waitlist_card_on_file: true })
          .eq('zip_code', zip)
          .eq('waitlist_stripe_customer_id', session.customer)
          .eq('status', 'waitlist');
        console.log(`Waitlist card saved: ZIP ${zip} by ${session.metadata.agentEmail}`);
        break;
      }
      
      // Handle mail credit purchases
      if (session.metadata?.type === 'mail_credits') {
        const credits = parseInt(session.metadata.credits) || 0;
        const agentEmail = session.metadata.agentEmail;
        if (credits > 0 && agentEmail) {
          // Upsert credits
          const { data: existing } = await supabase.from('mail_credits')
            .select('credits_remaining, credits_purchased').eq('user_id', agentEmail).single();
          
          if (existing) {
            await supabase.from('mail_credits').update({
              credits_remaining: existing.credits_remaining + credits,
              credits_purchased: existing.credits_purchased + credits,
              last_purchase_at: new Date().toISOString(),
              stripe_customer_id: session.customer,
            }).eq('user_id', agentEmail);
          } else {
            await supabase.from('mail_credits').insert({
              user_id: agentEmail,
              credits_remaining: credits,
              credits_purchased: credits,
              last_purchase_at: new Date().toISOString(),
              stripe_customer_id: session.customer,
            });
          }
          console.log(`Mail credits added: ${credits} for ${agentEmail}`);
        }
        break;
      }
      
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
      
      // Handle territory claims
      const zipCode = session.metadata?.zip_code;
      const action = session.metadata?.action;
      if (zipCode) {
        const claimEmail = session.metadata?.email || '';
        const status = action === 'waitlist' ? 'waitlist' : 'active';
        
        await supabase.from('territory_claims').upsert({
          zip_code: zipCode,
          user_id: session.customer,
          email: claimEmail,
          status: status,
          stripe_subscription_id: session.subscription,
          stripe_customer_id: session.customer,
          claimed_at: new Date().toISOString(),
        }, { onConflict: 'zip_code,user_id' });
        
        console.log(`Territory ${zipCode}: ${status} by ${claimEmail}`);
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
      
      // Check if this is a territory subscription
      const { data: territories } = await supabase.from('territory_claims')
        .select('zip_code, agent_email')
        .eq('stripe_subscription_id', subscription.id)
        .eq('status', 'active');
      
      if (territories?.length) {
        for (const t of territories) {
          // Release territory
          await supabase.from('territory_claims')
            .update({ status: 'cancelled' })
            .eq('zip_code', t.zip_code)
            .eq('status', 'active');
          
          console.log(`Territory released: ZIP ${t.zip_code} (${t.agent_email})`);
          
          // Check waitlist — auto-notify first in line
          const { data: waiters } = await supabase.from('territory_claims')
            .select('*')
            .eq('zip_code', t.zip_code)
            .eq('status', 'waitlist')
            .eq('waitlist_card_on_file', true)
            .order('waitlist_position', { ascending: true })
            .limit(1);
          
          if (waiters?.length) {
            // TODO: Auto-charge first waitlister via their saved payment method
            // For now, log it — manual follow-up
            console.log(`Waitlist trigger: ZIP ${t.zip_code} → ${waiters[0].agent_email} (position ${waiters[0].waitlist_position})`);
          }
        }
      }
      
      // Downgrade to free (existing logic)
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
    
    case 'invoice.paid': {
      // Recurring payment succeeded — reset monthly signal count
      const invoice = event.data.object;
      const customerId = invoice.customer;
      
      if (invoice.billing_reason === 'subscription_cycle') {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, plan')
          .eq('stripe_customer_id', customerId)
          .single();
        
        if (profile && profile.plan !== 'free') {
          await supabase
            .from('profiles')
            .update({
              signals_used: 0,
              billing_cycle_start: new Date().toISOString()
            })
            .eq('id', profile.id);
          
          console.log(`User ${profile.id} billing cycle reset (invoice.paid)`);
        }
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
// TERRITORY MANAGEMENT
// ===================

// GET /api/territories — all ZIPs with claim status + dynamic pricing
const { calculateTier } = require('./batch/pricing');

// Markets temporarily delisted from the claim UI until ATTOM data integration
// replaces the per-county GIS scraping pipeline. These ZIPs have broken data:
// - NY (Manhattan/Brooklyn/Scarsdale): NYS Tax Parcels feature service returns
//   addresses missing street names and FULL_MARKET_VAL = null for all NYC
//   parcels. NYC values are held by NYC DOF separately, not in the statewide
//   dataset.
// - OR Deschutes (Bend area): source GIS has zero value fields — no FCV, no
//   market value, no assessment. Deschutes keeps values in DIAL (paid subscription).
// - MT 59937 Whitefish: missing from zip_briefings entirely.
// When ATTOM ships, remove from this list — data will be uniform across all ZIPs.
const DELISTED_ZIPS = new Set([
  // NY broken addresses + null values
  '10013', '10014', '10021', '10024', '10583', '11201',
  // OR Deschutes zero-value pipeline
  '97701', '97702', '97703', '97707', '97756', '97759',
  // MT 59937 missing from zip_briefings
  '59937',
]);

app.get('/api/territories', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  try {
    // Get all briefings with calibration data
    const { data: briefings } = await supabase.from('zip_briefings')
      .select('zip_code, market_key, market_name, total_parcels, act_today_count, outreach_queue_count, calibration');
    
    // Get active claims
    const { data: claims } = await supabase.from('territory_claims')
      .select('zip_code, status, agent_name, agent_brokerage')
      .in('status', ['active', 'waitlist']);
    
    const claimMap = {};
    for (const c of (claims || [])) {
      if (c.status === 'active') {
        claimMap[c.zip_code] = { status: 'claimed', agent: c.agent_name, brokerage: c.agent_brokerage };
      } else if (c.status === 'waitlist') {
        if (!claimMap[c.zip_code]) claimMap[c.zip_code] = { status: 'available' };
        claimMap[c.zip_code].waitlistCount = (claimMap[c.zip_code].waitlistCount || 0) + 1;
      }
    }
    
    // Markets with sales data in their GIS
    const marketsWithSales = ['WA_KING', 'AZ_MARICOPA', 'FL_PB', 'FL_MD'];
    // Markets with calibration sold24 > 0 also have sales data
    
    const territories = (briefings || [])
      .filter(b => !DELISTED_ZIPS.has(b.zip_code))  // hide broken markets until ATTOM
      .map(b => {
      const cal = b.calibration || {};
      const sold24 = cal.sold24 || 0;
      const hasSalesData = marketsWithSales.includes(b.market_key) || sold24 > 0;
      const medianValue = cal.medianValue || 0; // from calibration if available
      
      const pricing = calculateTier(b.zip_code, medianValue, sold24, b.total_parcels, hasSalesData);
      
      return {
        zip: b.zip_code,
        market: b.market_name,
        marketKey: b.market_key,
        parcels: b.total_parcels,
        actToday: b.act_today_count,
        outreach: b.outreach_queue_count,
        status: claimMap[b.zip_code]?.status || 'available',
        claimedBy: claimMap[b.zip_code]?.agent || null,
        claimedBrokerage: claimMap[b.zip_code]?.brokerage || null,
        waitlistCount: claimMap[b.zip_code]?.waitlistCount || 0,
        price: pricing.price,
        tier: pricing.tier,
        tierLabel: pricing.label,
      };
    });
    
    res.json({ territories });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/territories/checkout — create Stripe checkout for ZIP claim
app.post('/api/territories/checkout', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!stripe) return res.status(500).json({ error: 'Payments not configured' });
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  const { zipCodes, plan, agentName, agentEmail, agentPhone, agentBrokerage } = req.body;
  if (!zipCodes?.length || !agentEmail) return res.status(400).json({ error: 'ZIP codes and email required' });
  
  // Plan multipliers applied to the ZIP's base tier price
  const PLAN_MULTIPLIERS = {
    monthly: 1.20,   // 20% premium for flexibility
    '6month': 1.00,  // base price (standard)
    annual: 0.90,    // 10% discount for annual commit
  };
  const planLabel = { monthly: 'Monthly', '6month': '6-Month Commitment', annual: 'Annual Commitment' };
  const multiplier = PLAN_MULTIPLIERS[plan] || 1.00;
  const commitLabel = planLabel[plan] || '6-Month Commitment';
  
  try {
    // Check availability
    const { data: existing } = await supabase.from('territory_claims')
      .select('zip_code').in('zip_code', zipCodes).eq('status', 'active');
    const taken = (existing || []).map(e => e.zip_code);
    const available = zipCodes.filter(z => !taken.includes(z));
    
    if (available.length === 0) {
      return res.json({ error: 'All selected ZIPs are already claimed', taken });
    }
    
    // Get calibration data for pricing
    const { data: briefings } = await supabase.from('zip_briefings')
      .select('zip_code, market_key, total_parcels, calibration')
      .in('zip_code', available);
    
    const marketsWithSales = ['WA_KING', 'AZ_MARICOPA', 'FL_PB', 'FL_MD'];
    
    // Create or get Stripe customer
    const customers = await stripe.customers.list({ email: agentEmail, limit: 1 });
    let customer = customers.data[0];
    if (!customer) {
      customer = await stripe.customers.create({
        email: agentEmail,
        name: agentName,
        phone: agentPhone,
        metadata: { brokerage: agentBrokerage }
      });
    }
    
    // Create checkout session with per-ZIP pricing
    const lineItems = available.map(zip => {
      const b = (briefings || []).find(x => x.zip_code === zip) || {};
      const cal = b.calibration || {};
      const sold24 = cal.sold24 || 0;
      const hasSalesData = marketsWithSales.includes(b.market_key) || sold24 > 0;
      const tier = calculateTier(zip, cal.medianValue || 0, sold24, b.total_parcels || 0, hasSalesData);
      const amount = Math.round(tier.price * multiplier * 100); // cents
      
      return {
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          recurring: { interval: 'month' },
          product_data: {
            name: `SellerSignal Territory — ZIP ${zip} (${tier.label})`,
            description: `Exclusive seller intelligence for ZIP ${zip}. ${commitLabel}.`,
          },
        },
        quantity: 1,
      };
    });
    
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'subscription',
      success_url: `${process.env.APP_URL || 'https://sellersignal.co'}/territories.html?success=true&zips=${available.join(',')}`,
      cancel_url: `${process.env.APP_URL || 'https://sellersignal.co'}/territories.html?canceled=true`,
      metadata: {
        zipCodes: available.join(','),
        plan: plan || '6month',
        agentName: agentName || '',
        agentEmail,
        agentPhone: agentPhone || '',
        agentBrokerage: agentBrokerage || '',
        type: 'territory_claim',
      },
    });
    
    res.json({ url: session.url, available, taken });
  } catch(e) {
    console.error('Territory checkout error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/territories/beta-claim — claim territory without payment (beta mode)
app.post('/api/territories/beta-claim', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  const { zipCodes, agentName, agentEmail, agentPhone, agentBrokerage } = req.body;
  if (!zipCodes?.length || !agentEmail) return res.status(400).json({ error: 'ZIP codes and email required' });
  
  // Authenticate via Supabase token
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Not authenticated. Please sign in first.' });
  
  try {
    // Check availability
    const { data: existing } = await supabase.from('territory_claims')
      .select('zip_code').in('zip_code', zipCodes).eq('status', 'active');
    const taken = (existing || []).map(e => e.zip_code);
    const available = zipCodes.filter(z => !taken.includes(z));
    
    if (available.length === 0) {
      return res.json({ error: 'All selected ZIPs are already claimed', taken });
    }
    
    // Create claims directly (no Stripe)
    // Look up market keys from zip_briefings
    const { data: briefingData } = await supabase.from('zip_briefings')
      .select('zip_code, market_key')
      .in('zip_code', available);
    const marketKeys = {};
    for (const b of (briefingData || [])) marketKeys[b.zip_code] = b.market_key;
    
    const claimed = [];
    for (const zip of available) {
      // Delete any existing inactive claims for this ZIP first
      await supabase.from('territory_claims')
        .delete()
        .eq('zip_code', zip)
        .neq('status', 'active');
      
      const { error: insertErr } = await supabase.from('territory_claims').insert({
        zip_code: zip,
        user_id: user.id,
        status: 'active',
        market_key: marketKeys[zip] || 'UNKNOWN',
        stripe_subscription_id: 'beta_' + Date.now(),
        agent_name: agentName || '',
        agent_email: agentEmail,
        agent_phone: agentPhone || '',
        agent_brokerage: agentBrokerage || '',
        claimed_at: new Date().toISOString(),
      });
      if (insertErr) {
        console.error(`[BETA] Insert error for ZIP ${zip}:`, insertErr.message);
      } else {
        claimed.push(zip);
        console.log(`[BETA] Territory claimed: ZIP ${zip} by ${agentEmail} (user: ${user.id})`);
      }
    }
    
    if (claimed.length === 0) {
      return res.status(500).json({ error: 'Failed to claim territories. Check server logs.' });
    }
    
    res.json({ success: true, claimed, taken });
  } catch(e) {
    console.error('Beta claim error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/territories/waitlist — join waitlist for a claimed ZIP
app.post('/api/territories/waitlist', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!stripe || !supabase) return res.status(503).json({ error: 'Not configured' });
  
  const { zipCode, agentName, agentEmail, agentPhone, agentBrokerage } = req.body;
  if (!zipCode || !agentEmail) return res.status(400).json({ error: 'ZIP and email required' });
  
  try {
    // Verify ZIP is actually claimed
    const { data: active } = await supabase.from('territory_claims')
      .select('zip_code').eq('zip_code', zipCode).eq('status', 'active').single();
    if (!active) return res.status(400).json({ error: 'This ZIP is available — claim it instead' });
    
    // Get waitlist position
    const { data: waiters } = await supabase.from('territory_claims')
      .select('id').eq('zip_code', zipCode).eq('status', 'waitlist');
    const position = (waiters?.length || 0) + 1;
    
    // Create Stripe customer for card on file
    const customers = await stripe.customers.list({ email: agentEmail, limit: 1 });
    let customer = customers.data[0];
    if (!customer) {
      customer = await stripe.customers.create({ email: agentEmail, name: agentName, metadata: { brokerage: agentBrokerage } });
    }
    
    // Create setup session to collect card
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'setup',
      success_url: `${process.env.APP_URL || 'https://sellersignal.co'}/territories.html?waitlist=true&zip=${zipCode}`,
      cancel_url: `${process.env.APP_URL || 'https://sellersignal.co'}/territories.html?canceled=true`,
      metadata: { zipCode, agentName: agentName || '', agentEmail, type: 'territory_waitlist' },
    });
    
    // Store waitlist entry
    await supabase.from('territory_claims').insert({
      zip_code: zipCode,
      market_key: '', // filled on activation
      status: 'waitlist',
      waitlist_position: position,
      waitlist_card_on_file: false,
      waitlist_stripe_customer_id: customer.id,
      agent_name: agentName,
      agent_email: agentEmail,
      agent_phone: agentPhone,
      agent_brokerage: agentBrokerage,
    });
    
    res.json({ url: session.url, position });
  } catch(e) {
    console.error('Waitlist error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===================
// DIRECT MAIL SYSTEM
// ===================
const { generateLetterSequence, letterToHtml, processMailQueue } = require('./batch/mail');

// Credit pack pricing (cents)
const MAIL_PACKS = {
  starter: { credits: 25, price: 9900, label: 'Starter — 25 Letters' },
  growth: { credits: 50, price: 17900, label: 'Growth — 50 Letters' },
  scale: { credits: 100, price: 29900, label: 'Scale — 100 Letters' },
};

// POST /api/mail/enroll — enroll sellers in mail campaign + generate letter sequences
app.post('/api/mail/enroll', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase || !anthropic) return res.status(503).json({ error: 'Not configured' });
  
  const { parcelIds, agentId, agentName, agentBrokerage, agentPhone, agentEmail } = req.body;
  if (!parcelIds?.length || !agentId) return res.status(400).json({ error: 'Parcel IDs and agent ID required' });
  
  // Check credits
  const { data: credits } = await supabase.from('mail_credits')
    .select('credits_remaining').eq('user_id', agentId).single();
  
  if (!credits || credits.credits_remaining < parcelIds.length) {
    return res.json({ error: 'Not enough credits', creditsNeeded: parcelIds.length, creditsAvailable: credits?.credits_remaining || 0 });
  }
  
  const agent = { name: agentName, brokerage: agentBrokerage, phone: agentPhone, email: agentEmail };
  const results = [];
  
  for (const parcelId of parcelIds) {
    try {
      // Get parcel data
      const { data: parcel } = await supabase.from('parcels')
        .select('*').eq('id', parcelId).single();
      const { data: score } = await supabase.from('parcel_scores')
        .select('*').eq('parcel_id', parcelId).single();
      const { data: ds } = await supabase.from('deep_signals')
        .select('*').eq('parcel_id', parcelId).single();
      
      if (!parcel) { results.push({ parcelId, error: 'Not found' }); continue; }
      
      // Check not already enrolled
      const { data: existing } = await supabase.from('mail_enrollments')
        .select('id').eq('parcel_id', parcelId).eq('agent_id', agentId).eq('status', 'active').single();
      if (existing) { results.push({ parcelId, error: 'Already enrolled' }); continue; }
      
      // Build seller context for letter generation
      const seller = {
        ownerName: parcel.owner_name,
        address: parcel.address,
        cityStateZip: `${parcel.city || ''}, ${parcel.state || ''} ${parcel.zip_code}`,
        cohort: score?.cohort || parcel.owner_type || 'residential',
        cohortLabel: score?.cohort === 'trust' ? 'Trust' : score?.cohort === 'estate' ? 'Estate' : score?.cohort === 'investor' ? 'LLC/Corp' : score?.cohort === 'absentee' ? 'Absentee' : 'Individual',
        totalValue: parcel.assessed_value || 0,
        mailingAddress: parcel.mailing_address || parcel.address,
        isOutOfState: parcel.is_out_of_state,
        isAbsentee: parcel.is_absentee,
        ownerState: parcel.mailing_state || parcel.state,
        tenureYears: parcel.tenure_years,
        deepSignalMotivation: ds?.motivation || '',
        deepSignalPsychology: ds?.report?.sellerPsychology || '',
      };
      
      // Generate 6 personalized letters
      const letters = await generateLetterSequence(anthropic, agent, seller);
      
      // Create enrollment
      const nextSend = new Date();
      nextSend.setDate(nextSend.getDate() + 3); // first letter sends in 3 days
      
      const { data: enrollment, error: enrollErr } = await supabase.from('mail_enrollments').insert({
        parcel_id: parcelId,
        zip_code: parcel.zip_code,
        agent_id: agentId,
        owner_name: parcel.owner_name,
        property_address: parcel.address,
        mailing_address: parcel.mailing_address || parcel.address,
        mailing_city: parcel.mailing_city || parcel.city,
        mailing_state: parcel.mailing_state || parcel.state,
        mailing_zip: parcel.mailing_zip || parcel.zip_code,
        cohort: seller.cohort,
        current_position: 0,
        total_letters: 6,
        status: 'active',
        next_send_at: nextSend.toISOString(),
      }).select('id').single();
      
      if (enrollErr) { results.push({ parcelId, error: enrollErr.message }); continue; }
      
      // Store all 6 letters
      const letterRows = letters.map(l => ({
        enrollment_id: enrollment.id,
        position: l.position,
        subject: l.subject,
        body_html: letterToHtml(l.body, agent),
        body_text: l.body,
      }));
      
      await supabase.from('mail_letters').insert(letterRows);
      
      // Deduct 1 credit per enrollment (covers all 6 letters)
      await supabase.rpc('decrement_mail_credits', { agent: agentId });
      
      results.push({ parcelId, enrollmentId: enrollment.id, letters: letters.length, status: 'enrolled' });
    } catch(e) {
      results.push({ parcelId, error: e.message });
    }
  }
  
  res.json({ results, enrolled: results.filter(r => r.status === 'enrolled').length });
});

// GET /api/mail/enrollments — get enrolled sellers for an agent
app.get('/api/mail/enrollments', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  const agentId = req.query.agent;
  const zip = req.query.zip;
  if (!agentId) return res.status(400).json({ error: 'Agent ID required' });
  
  let query = supabase.from('mail_enrollments')
    .select('*, mail_sends(position, status, sent_at, lob_url)')
    .eq('agent_id', agentId)
    .order('enrolled_at', { ascending: false });
  
  if (zip) query = query.eq('zip_code', zip);
  
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  
  res.json({ enrollments: data || [] });
});

// GET /api/mail/preview/:enrollmentId — preview letters for an enrollment
app.get('/api/mail/preview/:enrollmentId', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  const { data: letters } = await supabase.from('mail_letters')
    .select('position, subject, body_text')
    .eq('enrollment_id', req.params.enrollmentId)
    .order('position');
  
  res.json({ letters: letters || [] });
});

// POST /api/agent/profile — save agent profile (return address, branding)
app.post('/api/agent/profile', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  const { agentId, agentName, brokerage, phone, email, returnAddress, returnCity, returnState, returnZip, licenseNumber } = req.body;
  if (!agentId) return res.status(400).json({ error: 'Agent ID required' });
  
  const { data, error } = await supabase.from('agent_profiles').upsert({
    agent_id: agentId,
    agent_name: agentName,
    brokerage: brokerage,
    phone: phone,
    email: email,
    return_address: returnAddress,
    return_city: returnCity,
    return_state: returnState,
    return_zip: returnZip,
    license_number: licenseNumber,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'agent_id' });
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ saved: true });
});

app.options('/api/agent/profile', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// GET /api/agent/profile — get agent profile
app.get('/api/agent/profile', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  const agentId = req.query.agentId;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  
  const { data } = await supabase.from('agent_profiles')
    .select('*').eq('agent_id', agentId).single();
  
  res.json({ profile: data || null });
});

// GET /api/mail/campaigns — full campaign dashboard for an agent
app.get('/api/mail/campaigns', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  const agentId = req.query.agentId;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  
  const { data: enrollments } = await supabase.from('mail_enrollments')
    .select('*, mail_letters(position, subject, body_text), mail_sends(position, status, sent_at, lob_url)')
    .eq('agent_id', agentId)
    .order('enrolled_at', { ascending: false });
  
  const { data: credits } = await supabase.from('mail_credits')
    .select('*').eq('user_id', agentId).single();
  
  res.json({
    enrollments: enrollments || [],
    credits: credits || { credits_remaining: 0, credits_purchased: 0, credits_used: 0 },
    summary: {
      active: (enrollments || []).filter(e => e.status === 'active').length,
      completed: (enrollments || []).filter(e => e.status === 'completed').length,
      totalLettersSent: (enrollments || []).reduce((s, e) => s + e.current_position, 0),
      totalSellers: (enrollments || []).length,
    }
  });
});

// GET /api/mail/credits — check credit balance
app.get('/api/mail/credits', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  const agentId = req.query.agent;
  if (!agentId) return res.status(400).json({ error: 'Agent ID required' });
  
  const { data } = await supabase.from('mail_credits')
    .select('*').eq('user_id', agentId).single();
  
  res.json({ credits: data || { credits_remaining: 0, credits_purchased: 0, credits_used: 0 } });
});

// POST /api/mail/credits/purchase — buy credit pack via Stripe
app.post('/api/mail/credits/purchase', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!stripe) return res.status(500).json({ error: 'Payments not configured' });
  
  const { pack, agentEmail, agentName } = req.body;
  const packInfo = MAIL_PACKS[pack];
  if (!packInfo) return res.status(400).json({ error: 'Invalid pack. Options: starter, growth, scale' });
  
  try {
    const customers = await stripe.customers.list({ email: agentEmail, limit: 1 });
    let customer = customers.data[0];
    if (!customer) customer = await stripe.customers.create({ email: agentEmail, name: agentName });
    
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: packInfo.price,
          product_data: { name: `SellerSignal Mail Credits — ${packInfo.label}` },
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.APP_URL || 'https://sellersignal.co'}/sellersignal-briefing.html?mail_credits=true&pack=${pack}`,
      cancel_url: `${process.env.APP_URL || 'https://sellersignal.co'}/sellersignal-briefing.html?mail_canceled=true`,
      metadata: { type: 'mail_credits', pack, credits: String(packInfo.credits), agentEmail },
    });
    
    res.json({ url: session.url });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mail/send-due — process mail queue (called by cron)
app.post('/api/mail/send-due', async (req, res) => {
  const BATCH_KEY = process.env.BATCH_SECRET || 'ss_batch_2026';
  if (req.query.key !== BATCH_KEY) return res.status(403).json({ error: 'Invalid key' });
  
  const lobKey = process.env.LOB_API_KEY;
  if (!lobKey) return res.status(503).json({ error: 'Lob not configured' });
  
  const result = await processMailQueue(supabase, anthropic, lobKey);
  res.json(result);
});

// ===================
// SHARED DEEP SIGNAL PROMPT — used by both POST and SSE endpoints
// ===================
function buildDeepSignalPrompt(propertyAddress, preliminaryScore, city, marketProfile) {
  const marketSection = marketProfile ? `

MARKET-SPECIFIC INTELLIGENCE FOR THIS PROPERTY'S REGION:
${marketProfile}

Apply this market context when evaluating signals. A trust in Palm Beach means something different than a trust in Seattle. An absentee owner from Minnesota in Phoenix is a snowbird aging out of seasonal use — that's a high-confidence seller signal. Interpret EVERY feature through the lens of what it means in THIS specific market.

` : '';

  return `You are SellerSignal's Deep Signal engine — an expert real estate predictive modeling system specializing in off-market seller propensity. You analyze residential property owners and assign a seller likelihood score based on behavioral, ownership, demographic, financial, market-position, and operational signals.
${marketSection}
CRITICAL RULES:
- The property being evaluated is at "${propertyAddress}". ALL scripts and market references must be about THIS location.
- Do NOT use a one-size-fits-all model. Segment the owner first, then apply segment-specific logic.
- "Not found" is a last resort. Infer from property data, ownership patterns, and neighborhood context when direct data is absent. Label inferences clearly.
- Extract ALL phone numbers, email addresses, ages, and spouse names from search results — especially from FastPeopleSearch, WhitePages, Spokeo snippets.
- If the owner is an entity and a principal/member has been identified, build the profile around THAT PERSON.
- COUNTY ASSESSED VALUES ARE TAX BASIS ONLY — they are often 30-80% below actual market value, especially in Montana. NEVER use assessed value as estimated market value. Use Zillow/Redfin/Realtor estimates from search results for the estimatedMarketValue field. If no listing-site estimate is found, note "Not found from search data" — do NOT fall back to assessed value.

DATA HONESTY RULES — VIOLATIONS DESTROY USER TRUST:

Signals must represent REAL evidence about THIS specific owner. A signal is only valid if it meets ALL three tests:
  1. EVIDENCE-BASED: You found something concrete — a fact, a record, a search result. Not "I couldn't find anything."
  2. INDIVIDUAL: It's about THIS person or THIS property. Not a neighborhood-wide observation.
  3. DIFFERENTIATING: It wouldn't apply equally to every other parcel in this ZIP code.

FORBIDDEN SIGNAL PATTERNS — never include these in the signals array:

A. ABSENCE-OF-EVIDENCE as positive signals. These are invalid:
   ❌ "No digital footprint" / "No online presence" / "No social media"
   ❌ "No recent listing history" / "Not in MLS"
   ❌ "Limited public information" / "Minimal search results"
   ❌ "Complete absence of owner data"
   ❌ "Unable to verify X" / "Cannot locate Y"
   The absence of information is not a seller signal. It is a data quality limitation.

B. MACRO-MARKET OBSERVATIONS as individual signals. These apply to every parcel in the ZIP:
   ❌ "Property in rapidly gentrifying [neighborhood]"
   ❌ "Rising property values in the area"
   ❌ "Hot market / appreciating neighborhood"
   ❌ "Market conditions favor sellers"
   If the signal applies to 1000+ other parcels in this ZIP, it is not a signal about THIS owner.

C. TAUTOLOGICAL RESTATEMENTS of the input:
   ❌ "Owner name appears as [input name]"
   ❌ "Individual ownership based on name format"
   ❌ "Property located at [input address]"
   These are not confirmed facts — they are just echoing what was given to you.

D. GENERIC BOILERPLATE psychology that applies to everyone:
   ❌ "Privacy concerns likely create resistance"
   ❌ "May be emotionally attached to property"
   ❌ "Motivated by rising values if long-term resident"
   Only include sellerPsychology claims grounded in something specific — segment, tenure, age, family situation, entity type — not generic hedges.

WHEN YOU HAVE NO REAL EVIDENCE:
If search results returned nothing meaningful about this owner, the correct response is:
  - signals: []  (empty array — it is better to show nothing than fabricate)
  - confirmedFacts: [only facts you actually confirmed, or []]
  - sellerPsychology: null or {} if you cannot ground it in specific evidence
  - dataQuality: "Limited"
  - sellerLikelihood: keep close to the preliminary heuristic score; do not inflate

An empty signals array is a HONEST result. Manufactured signals are a BROKEN result that makes users distrust the entire system. When in doubt, return less — not more.

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

Score INDEPENDENTLY based on the evidence you find in search results. Do NOT anchor to any preliminary score.

The parcel data produced a preliminary heuristic score of ${preliminaryScore || 35}, but this score is based ONLY on ownership structure and property data — it does NOT account for the person-level intelligence you are about to analyze. Your score should reflect the FULL picture including search results. Corrections of 30+ points from the preliminary score are expected and appropriate when search evidence strongly supports a different assessment.

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
  "sellerLikelihood": 0-100,
  "scoreLabel": "Very High/High/Moderate/Low/Unlikely",
  "scoreBasis": "2-3 sentences explaining what confirmed and inferred factors drove this score",
  "sellerLikelihoodBasis": "same as scoreBasis",
  "timeframe": "0-3 months / 3-6 months / 6-12 months / 12-24 months / 24+ months",
  "timeframeReasoning": "Why this timeframe",
  "motivationCategory": "Estate Transition / Equity Harvest / Portfolio Simplification / Life-Stage Change / Financial Pressure / Operational Burden / Representation Mismatch / Legacy Relief / Unknown",
  "offMarketScore": 0-100,
  "offMarketReceptivity": 0-100,
  "offMarketReasoning": "Why they would or wouldn't prefer off-market",
  "confidenceScore": 0-100,
  "confidence": 0-100,
  "confidenceReasoning": "How much data supports this assessment",
  "actionability": 0-100,
  "actionabilityReasoning": "Can an agent act on this now? Named human + usable contact path + clear next move = high. Opaque entity, no path = low.",
  "bestNextMove": "Call first / Mail first / Research first / Watch",
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
      { label: 'Zillow Active', query: `site:zillow.com "${city}" ${state} "for sale" OR "active" -"sold" -"off market"` },
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
      } else if (label.includes('Active')) {
        signalType = 'active_listing';
        signalWeight = -30; // BLOCKER — negative weight, this is bad for seller likelihood
        signalText = 'Currently listed for sale — has agent';
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
// DEEP SIGNAL LITE — Batch scoring without web search
// Uses Claude to rank candidates from parcel data only. Cheap and fast.
// ===================
app.post('/api/deep-signal-lite', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  
  // Rate limit by IP (prevent abuse — this endpoint uses Anthropic API credits)
  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(`lite_${clientIp}`, 5, 60000)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }
  
  try {
    const { candidates, calibration, marketProfile } = req.body;
    if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
      return res.status(400).json({ error: 'candidates array required' });
    }
    
    // Cap at 100 per request
    const batch = candidates.slice(0, 100);
    console.log(`Deep Signal Lite: scoring ${batch.length} evidence bundles${calibration ? ' (with market calibration)' : ''}${marketProfile ? ' (with market profile)' : ''}`);
    const startTime = Date.now();
    
    // Build evidence-formatted candidate descriptions
    const candidateList = batch.map((c, i) => {
      const obs = c.observed || {};
      const der = c.derived || {};
      const gaps = c.gaps || [];
      const conf = c.confidence || {};
      const ev = c.evidenceSummary || {};
      
      let desc = `[${i+1}] ${obs.ownerName || 'Unknown'} — ${obs.situsAddress || 'No address'}`;
      desc += `\n  OWNER: ${obs.ownerType || 'unknown'} | Name: ${obs.ownerName || '?'}`;
      desc += `\n  PROPERTY: $${(obs.assessedValue||0).toLocaleString()} total (land: $${(obs.landValue||0).toLocaleString()}, building: $${(obs.buildingValue||0).toLocaleString()}) | ${obs.propertyType || 'unknown'} | Vacant: ${obs.isVacantLand ? 'Yes' : 'No'}`;
      desc += `\n  OCCUPANCY: ${der.likelyOccupancy || 'unknown'} | Absentee: ${obs.isAbsentee ? 'Yes' : 'No'} | Out-of-state: ${obs.isOutOfState ? 'Yes' : 'No'}${obs.isOutOfState ? ' (mailing to ' + (obs.mailingState || '?') + ')' : ''}`;
      desc += `\n  TENURE: ${der.tenureYears != null ? der.tenureYears + ' years (' + der.tenureBucket + ')' : der.tenureBucket || 'unknown'}`;
      desc += `\n  PORTFOLIO: ${der.portfolioSize || 1} properties (${der.portfolioClass || 'single'})`;
      desc += `\n  CONTACT: mail=${der.mailPathQuality || 'unknown'}, identity=${der.ownerIdentityQuality || 'unknown'}`;
      desc += `\n  BURDEN: ${der.propertyBurden || 'unknown'}`;
      
      if (ev.timeSignals?.length) desc += `\n  TIME: ${ev.timeSignals.join('; ')}`;
      if (ev.transitionSignals?.length) desc += `\n  TRANSITION: ${ev.transitionSignals.join('; ')}`;
      if (ev.burdenSignals?.length) desc += `\n  BURDEN SIGNALS: ${ev.burdenSignals.join('; ')}`;
      if (ev.contactSignals?.length) desc += `\n  CONTACT SIGNALS: ${ev.contactSignals.join('; ')}`;
      if (ev.blockerSignals?.length) desc += `\n  ⚠ BLOCKERS: ${ev.blockerSignals.join('; ')}`;
      
      if (gaps.length) desc += `\n  GAPS: ${gaps.join(', ')}`;
      desc += `\n  DATA CONFIDENCE: ownership=${conf.ownership||'?'}, tenure=${conf.tenure||'?'}, contact=${conf.contact||'?'}, market=${conf.market||'?'}`;
      
      // Show heuristic pre-score as context only — NOT as a starting point
      const bs = c.baseScores || {};
      desc += `\n  HEURISTIC PRE-SCORE (for reference only): SL=${bs.sellerLikelihood||'?'} OMR=${bs.offMarketReceptivity||'?'} ACT=${bs.actionability||'?'} CONF=${bs.confidence||'?'}`;
      
      return desc;
    }).join('\n\n');
    
    // Build the unified prompt with all three intelligence inputs
    let statisticalContext = '';
    if (calibration && calibration.featureRates) {
      statisticalContext = `
STATISTICAL REALITY — observed outcomes in ZIP ${calibration.zipCode || '?'} over 24 months:
Base turnover rate: ${calibration.baseRate24mo || '?'}% of properties transacted
Total sales observed: ${calibration.sold24mo || '?'} out of ${calibration.sampleSize || '?'} properties
Avg heuristic score of properties that SOLD: ${calibration.avgScoreSold || '?'}
Avg heuristic score of properties that DID NOT sell: ${calibration.avgScoreNotSold || '?'}

Feature conversion rates (% of properties with this feature that actually sold in 24 months):
${Object.entries(calibration.featureRates).map(([k,v]) => `  ${k}: ${v}`).join('\n')}

USE THESE RATES as your probability anchor. If trusts sell at 50% in this market, a trust with no other signals should score around 50 for seller likelihood. If named individuals sell at 33%, an individual with no other signals should start around 33. Additional evidence (transition signals, life events, tenure, absentee status) should MOVE the score up or down from this anchor based on whether the evidence suggests this specific owner is MORE or LESS likely to sell than the average for their feature group.`;
    }
    
    let marketContext = '';
    if (marketProfile) {
      marketContext = `
MARKET PSYCHOLOGY — how people buy and sell in this specific geography:
${marketProfile}

USE THIS CONTEXT to interpret WHY features matter differently here. A trust in Palm Beach means estate planning (baseline, not a signal). A trust in Charlotte means generational wealth transfer (strong signal). An out-of-state absentee in Phoenix with a Minnesota mailing address is an aging snowbird (very strong signal). The same pattern in Seattle is a tech worker who relocated (different psychology, different timeline). Score based on what these features MEAN for this specific person in this specific market.`;
    }
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      temperature: 0,
      system: `You are SellerSignal's unified intelligence engine. You produce seller likelihood scores by merging three inputs simultaneously:

1. STATISTICAL REALITY — what actually happened in this market (conversion rates, base turnover, feature-level outcomes)
2. PSYCHOLOGICAL PROFILING — what this specific owner's situation suggests about their motivation and timeline
3. MARKET CONTEXT — how people in this geography and price bracket behave when they sell

You are NOT refining a heuristic score. You are producing an INDEPENDENT assessment of each prospect's probability of selling within 12 months. The heuristic pre-score is shown for reference only — ignore it if your analysis disagrees.

SCORING FRAMEWORK:

Seller Likelihood (0-100): Estimated probability this property transacts within 12 months. Anchor to the statistical base rate for this market, then adjust based on this owner's specific situation.
- If the base rate is 7.8% and this owner has no distinguishing features: SL = 8-12
- If this owner matches the profile of past sellers (entity type, tenure, absentee pattern that converts at 3-5x base rate): SL = 25-50
- If there are active transition signals (estate settlement, relocation evidence, life event): SL = 50-75
- If multiple corroborated transition signals with timing evidence: SL = 75-90
- Blockers (active listing, recent purchase) should suppress to SL = 5-15 regardless of other signals

Off-Market Receptivity (0-100): How likely is this owner to consider an off-market approach? Consider: are they likely to already have agent relationships? Would they be motivated by privacy, speed, or convenience? Absentee owners managing remotely are often MORE receptive. Owner-occupants who are emotionally attached are LESS receptive unless a life event forces the issue.

Actionability (0-100): Can an agent actually reach and engage this person? Consider: is the mailing address valid? Is the owner identifiable (named person vs anonymous entity)? Is there a clear contact path? A trust with no trustee name and a PO box is less actionable than a named individual with a residential mailing address.

Confidence (0-100): How much do you trust your own assessment? High confidence requires: known tenure, verified ownership type, clear occupancy status, and market data. Low confidence means: major gaps in data, contradictory signals, or unknown tenure.

CRITICAL RULES:
- PRODUCE VARIANCE. If all scores cluster around 35-45, you are failing. A diverse pool of 100 prospects should produce scores ranging from 10 to 80+. Some prospects are genuinely high-probability. Many are genuinely low. Spread them.
- Entity type alone is NOT a score. A trust that has been static for 30 years with no transition signals scores LOWER than a named individual with a recent mailing address change and 20-year tenure.
- The psychological question for each prospect is: "What would cause THIS person to sell THIS property in THIS market within the next year?" If you can't articulate a plausible scenario, the score should be low.
- Life events (death, divorce, retirement, relocation, job loss) are the strongest signals. They represent INVOLUNTARY or SEMI-VOLUNTARY transitions where the owner's circumstances changed. Weight these heavily.
- Voluntary sellers (equity harvesters, portfolio rebalancers, lifestyle changers) are real but lower-probability. They require multiple confirming signals.
- When statistical data and psychological analysis conflict, explain which you weighted more heavily and why.
${statisticalContext}
${marketContext}

OUTPUT per candidate (JSON):
{
  "id": 1,
  "sellerLikelihood": 0-100 (anchored to market base rate, adjusted by evidence),
  "offMarketReceptivity": 0-100,
  "actionability": 0-100,
  "confidence": 0-100,
  "topReason": "One sentence: the specific psychological/situational reason this owner may or may not sell — not a generic description of their entity type",
  "bestNextMove": "Call first|Mail first|Research first|Watch",
  "mainBlocker": "Primary reason for caution, or null"
}

Return ONLY a JSON array. No explanation. No markdown.`,
      messages: [{
        role: 'user',
        content: `Score these ${batch.length} prospects. For each one, assess their seller likelihood by merging statistical market data, psychological profiling of their ownership situation, and market context. Produce scores with meaningful variance — not clustered around the middle.\n\n${candidateList}\n\nReturn ONLY the JSON array.`
      }]
    });
    
    let textContent = '';
    for (const block of response.content) {
      if (block.type === 'text') textContent += block.text;
    }
    
    // Parse JSON array from response
    const jsonMatch = textContent.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Could not parse Lite response');
    const scores = JSON.parse(jsonMatch[0]);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  Deep Signal Lite: ${scores.length} scores in ${elapsed}s`);
    
    res.json({ scores, elapsed, count: scores.length });
    
  } catch (error) {
    console.error('Deep Signal Lite error:', error);
    res.status(500).json({ error: error.message || 'Lite scoring failed' });
  }
});

app.options('/api/deep-signal-lite', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

// ===================
// LIFE-EVENT SCAN — cheap targeted searches for transition signals
// 1-2 searches per candidate, pattern matching on snippets, no LLM
// ===================
// Pattern match fallback for life-event scan (used when no API key or extraction fails)
function patternMatchFallback(name, results) {
    const found = [];
    const nameUpper = (name || '').toUpperCase();
    const lastName = nameUpper.split(/[\s,]+/).filter(Boolean).pop() || '';
    
    for (const r of results) {
        const snippets = (r.results || []).map(x => `${x.title || ''} ${x.snippet || ''}`).join(' ');
        const snippetsUpper = snippets.toUpperCase();
        
        if (r.type === 'obituary') {
            if (lastName && snippetsUpper.includes(lastName) && /OBITUAR|PASSED\s*AWAY|DEATH\s*NOTICE|MEMORIAL|PROBATE|SURVIVED\s*BY/i.test(snippets))
                found.push({ type: 'obituary', signal: 'Possible obituary/death in household', confidence: 'medium' });
            if (lastName && snippetsUpper.includes(lastName) && /PROBATE|ESTATE\s*OF|EXECUTOR|ADMINISTRATOR/i.test(snippets))
                found.push({ type: 'probate', signal: 'Probate filing detected', confidence: 'high' });
        }
        if (r.type === 'listing') {
            // ACTIVE LISTING — this is a BLOCKER, not a positive signal
            if (/\$([\d,]+)\s*(K|M|,000)?\s*(\||—|-|·)?\s*(FOR SALE|ACTIVE|CURRENTLY LISTED|ON MARKET|NEW LISTING|JUST LISTED|LISTED FOR|LIST PRICE|ASKING)/i.test(snippets) ||
                /(?:FOR SALE|ACTIVE|CURRENTLY LISTED|ON MARKET|NEW LISTING|JUST LISTED|LISTED)\s*(?:AT|FOR|—|-|·|\|)?\s*\$[\d,]+/i.test(snippets) ||
                /ZILLOW.*(?:FOR SALE|LISTED|ACTIVE)|REDFIN.*(?:FOR SALE|LISTED|ACTIVE)|REALTOR.*(?:FOR SALE|LISTED|ACTIVE)/i.test(snippets)) {
                // Only flag if NOT also showing expired/withdrawn
                if (!/WITHDRAWN|EXPIRED|CANCELED|DELISTED|OFF\s*MARKET|SOLD|PENDING|CONTINGENT/i.test(snippets)) {
                    found.push({ type: 'listing_active', signal: 'Property is currently listed for sale — has agent representation', confidence: 'high' });
                }
            }
            if (/WITHDRAWN|EXPIRED|CANCELED|DELISTED|OFF\s*MARKET/i.test(snippets))
                found.push({ type: 'listing_failed', signal: 'Prior listing attempt failed', confidence: 'medium' });
            if (/PRICE\s*REDUC|PRICE\s*CUT|PRICE\s*DROP/i.test(snippets))
                found.push({ type: 'price_reduced', signal: 'Price reduction history', confidence: 'medium' });
            // Extract listing timeframe if available
            const yearMatch = snippets.match(/(listed|sold|withdrawn|expired)\s*(?:in\s*)?(\d{4})/i);
            if (yearMatch) {
                const listYear = parseInt(yearMatch[2]);
                const yearsAgo = new Date().getFullYear() - listYear;
                if (yearsAgo <= 2 && /WITHDRAWN|EXPIRED|CANCELED/i.test(snippets)) {
                    found.push({ type: 'listing_failed', signal: `Recent listing activity (~${listYear}) — expired/withdrawn`, confidence: 'high' });
                }
            }
        }
        if (r.type === 'business') {
            if (/DISSOLV|INACTIVE|REVOKED/i.test(snippets))
                found.push({ type: 'business_dissolution', signal: 'Business dissolution detected', confidence: 'medium' });
            if (/RETIRE|RETIREMENT/i.test(snippets) && lastName && snippetsUpper.includes(lastName))
                found.push({ type: 'retirement', signal: 'Retirement evidence', confidence: 'low' });
        }
        
        // Enhanced: person-search snippet extraction
        if (r.type === 'person' && lastName && snippetsUpper.includes(lastName)) {
            // Age extraction from people-search sites (FastPeopleSearch, WhitePages, Spokeo)
            const ageMatch = snippets.match(/(?:age|aged?)[:\s]+(\d{2,3})/i);
            if (ageMatch) {
                const age = parseInt(ageMatch[1]);
                if (age >= 18 && age <= 105) {
                    const conf = age >= 60 ? 'medium' : 'low';
                    found.push({ type: 'age_indicator', signal: `Estimated age: ${age}`, confidence: conf, source: 'person_search' });
                    if (age >= 65) found.push({ type: 'retirement', signal: `Age ${age} — likely retired or approaching retirement`, confidence: 'low', source: 'person_search' });
                    if (age >= 55 && age <= 70) found.push({ type: 'empty_nester', signal: `Age ${age} — possible empty nester`, confidence: 'low', source: 'person_search' });
                }
            }
            // Employment extraction from LinkedIn-style snippets
            if (/RETIRED|FORMER\s+(CEO|PRESIDENT|DIRECTOR|VP|MANAGER|PARTNER|EXECUTIVE)/i.test(snippets))
                found.push({ type: 'retirement', signal: 'Retirement indicated in profile', confidence: 'medium', source: 'person_search' });
            // Relocation signals
            if (/MOVED\s+TO|RELOCATED|PREVIOUSLY\s+LIVED/i.test(snippets))
                found.push({ type: 'relocation', signal: 'Relocation evidence', confidence: 'low', source: 'person_search' });
        }
        
        // General signals (any result type)
        if (lastName && snippetsUpper.includes(lastName)) {
            if (/BANKRUPT|CHAPTER\s*(7|11|13)|FORECLOS/i.test(snippets))
                found.push({ type: 'bankruptcy', signal: 'Bankruptcy or foreclosure signal', confidence: 'medium' });
            if (/NURSING|ASSISTED\s*LIVING|SENIOR\s*LIVING|CARE\s*FACILITY|MEMORY\s*CARE/i.test(snippets))
                found.push({ type: 'care_facility', signal: 'Care facility reference', confidence: 'low' });
            if (/DIVORCE|DISSOLUTION\s*OF\s*MARRIAGE/i.test(snippets))
                found.push({ type: 'divorce', signal: 'Divorce record detected', confidence: 'medium' });
        }
    }
    
    // Deduplicate by type
    const seen = new Set();
    return found.filter(f => {
        const key = `${f.type}_${f.confidence}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

app.post('/api/life-event-scan', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  
  // Rate limit by IP (no auth required but prevent abuse)
  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(`le_${clientIp}`, 10, 60000)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }
  
  try {
    const { candidates } = req.body;
    if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
      return res.status(400).json({ error: 'candidates array required' });
    }
    
    const batch = candidates.slice(0, 150); // cap at 150
    console.log(`Life-event scan: ${batch.length} candidates`);
    const startTime = Date.now();
    
    // Build targeted search queries — 2 per candidate max
    const allQueries = [];
    for (let i = 0; i < batch.length; i++) {
      const c = batch[i];
      const name = (c.ownerName || '').trim();
      const city = (c.city || '').trim();
      const state = (c.state || '').trim();
      const address = (c.address || '').trim();
      
      if (!name || name.length < 4) continue;
      
      // Extract last name for obituary search
      const nameParts = name.split(/[\s,]+/).filter(Boolean);
      const lastName = nameParts.length >= 2 ? nameParts[nameParts.length - 1] : name;
      
      // Query 1: obituary / death / probate / estate — use full name first for precision
      const obitSearchName = nameParts.length >= 2 ? name : lastName;
      allQueries.push({
        label: `life_${i}_obit`,
        candidateIdx: i,
        type: 'obituary',
        query: `"${obitSearchName}" ${city} ${state} obituary OR death OR probate 2024 2025 2026`
      });
      
      // Query 2: listing history at address
      if (address) {
        allQueries.push({
          label: `life_${i}_listing`,
          candidateIdx: i,
          type: 'listing',
          query: `"${address}" ${city} listed OR sold OR withdrawn OR "price reduced" OR expired`
        });
      }
      
      // Query 3: person intelligence — age, employer, retirement, life changes
      allQueries.push({
        label: `life_${i}_person`,
        candidateIdx: i,
        type: 'person',
        query: `"${c.ownerName}" ${city} ${state}`
      });
    }
    
    // Fire all searches in parallel batches of 12
    const searchResults = {};
    const batchSize = 12;
    for (let i = 0; i < allQueries.length; i += batchSize) {
      const qBatch = allQueries.slice(i, i + batchSize);
      const promises = qBatch.map(async (q) => {
        try {
          const results = await searchGoogle(q.query);
          return { label: q.label, candidateIdx: q.candidateIdx, type: q.type, results: results || [] };
        } catch(e) { return { label: q.label, candidateIdx: q.candidateIdx, type: q.type, results: [] }; }
      });
      const settled = await Promise.allSettled(promises);
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          if (!searchResults[r.value.candidateIdx]) searchResults[r.value.candidateIdx] = [];
          searchResults[r.value.candidateIdx].push(r.value);
        }
      }
      if (i + batchSize < allQueries.length) await new Promise(r => setTimeout(r, 150));
    }
    
    // ============================================================
    // PERSON INTELLIGENCE EXTRACTION — read snippets like an investigator
    // Top 20 candidates get Claude extraction (full person intelligence)
    // Rest get expanded pattern matching (still better than before)
    // ============================================================
    const events = [];
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    const CLAUDE_EXTRACTION_CAP = 50; // top 50 get full LLM extraction, rest get enhanced pattern matching
    
    // Process in batches of 5 candidates through Claude
    const extractionBatchSize = 5;
    for (let batchStart = 0; batchStart < batch.length; batchStart += extractionBatchSize) {
      const batchEnd = Math.min(batchStart + extractionBatchSize, batch.length);
      
      const extractionPromises = [];
      for (let i = batchStart; i < batchEnd; i++) {
        const c = batch[i];
        const results = searchResults[i] || [];
        if (results.length === 0) continue;
        
        // Collect all snippets for this person
        const allSnippets = [];
        for (const r of results) {
          for (const x of (r.results || [])) {
            const snippet = `[${x.title || ''}] ${x.snippet || ''}`;
            if (snippet.trim().length > 10) allSnippets.push(snippet);
          }
        }
        if (allSnippets.length === 0) continue;
        
        const name = (c.ownerName || '').trim();
        const city = (c.city || '').trim();
        const state = (c.state || '').trim();
        const address = (c.address || '').trim();
        
        // If no API key or past extraction cap, use pattern matching
        if (!ANTHROPIC_KEY || i >= CLAUDE_EXTRACTION_CAP) {
          const found = patternMatchFallback(name, results);
          if (found.length > 0) events.push({ candidateIdx: i, parcelId: c.parcelId || null, events: found });
          continue;
        }
        
        extractionPromises.push((async () => {
          try {
            const extractionPrompt = `You are a real estate intelligence analyst. Analyze these search results about a property owner and extract EVERY person-level signal that could indicate seller likelihood.

SUBJECT: ${name}
LOCATION: ${city}, ${state}
PROPERTY: ${address}

SEARCH RESULTS:
${allSnippets.slice(0, 15).join('\n\n')}

Extract ALL of the following signals if present. Return ONLY valid JSON, no markdown, no preamble.

{
  "signals": [
    {
      "type": "one of: obituary, probate, divorce, retirement, employment_change, relocation, business_dissolution, bankruptcy, care_facility, empty_nester, health_issue, inheritance, listing_failed, listing_active, price_reduced, recently_sold, age_indicator, financial_distress, lifestyle_change, family_change",
      "detail": "specific detail found",
      "confidence": "high/medium/low",
      "snippet": "exact text that supports this"
    }
  ],
  "person_profile": {
    "estimated_age": null or number,
    "likely_retired": null or true/false,
    "employment": null or "description",
    "family_status": null or "description",
    "financial_indicators": null or "description",
    "location_stability": null or "description"
  }
}

Rules:
- Only extract signals about THIS specific person (${name}) in ${city}, ${state}
- If a common name appears in results about a DIFFERENT person, mark confidence "low"
- If the age, city, and name all match, mark confidence "high"
- Be specific in detail — "retired from Boeing in 2023" not just "retirement signal"
- If nothing relevant found, return {"signals": [], "person_profile": {}}`;

            const resp = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1000,
                messages: [{ role: 'user', content: extractionPrompt }]
              })
            });
            
            const data = await resp.json();
            const text = (data.content || []).map(c => c.text || '').join('').trim();
            const cleaned = text.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            
            const found = [];
            for (const sig of (parsed.signals || [])) {
              found.push({
                type: sig.type,
                signal: sig.detail,
                confidence: sig.confidence || 'low',
                snippet: sig.snippet || '',
                source: 'person_intelligence'
              });
            }
            
            // Add person profile as a special signal
            if (parsed.person_profile) {
              const pp = parsed.person_profile;
              if (pp.estimated_age) found.push({ type: 'age_indicator', signal: `Estimated age: ${pp.estimated_age}`, confidence: 'medium', source: 'person_intelligence' });
              if (pp.likely_retired === true) found.push({ type: 'retirement', signal: pp.employment || 'Likely retired', confidence: 'medium', source: 'person_intelligence' });
              if (pp.financial_indicators) found.push({ type: 'financial_indicator', signal: pp.financial_indicators, confidence: 'low', source: 'person_intelligence' });
              if (pp.family_status && /empty.nest|widow|divorced|single/i.test(pp.family_status)) found.push({ type: 'family_change', signal: pp.family_status, confidence: 'low', source: 'person_intelligence' });
            }
            
            if (found.length > 0) {
              events.push({ candidateIdx: i, parcelId: c.parcelId || null, events: found, personProfile: parsed.person_profile || null });
            }
          } catch(e) {
            // Fall back to pattern matching on error
            console.error(`  Person intel extraction failed for ${name}: ${e.message}`);
            const found = patternMatchFallback(name, results);
            if (found.length > 0) events.push({ candidateIdx: i, parcelId: c.parcelId || null, events: found });
          }
        })());
      }
      
      if (extractionPromises.length > 0) {
        await Promise.allSettled(extractionPromises);
      }
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalSearches = allQueries.length;
    console.log(`  Life-event scan: ${events.length} candidates with events from ${totalSearches} searches in ${elapsed}s`);
    
    res.json({ events, elapsed, totalSearches, candidatesScanned: batch.length });
    
  } catch (error) {
    console.error('Life-event scan error:', error);
    res.status(500).json({ error: error.message || 'Life-event scan failed' });
  }
});

app.options('/api/life-event-scan', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

// ===================
// BETA DEEP SIGNAL v2 — No auth, rate limited, parallel research
// ===================
const betaDailyLimit = { count: 0, resetTime: Date.now() + 86400000 };

app.post('/api/beta-research', async (req, res) => {
  // CORS for standalone HTML
  res.header('Access-Control-Allow-Origin', '*');
  
  // =====================================================================
  // CACHE-FIRST: Check the deep_signals table before burning SerpAPI.
  // The batch pipeline (batch/worker.js) generates grounded Deep Signals
  // for the top 5 parcels of every ZIP during nightly runs, pulling rich
  // research data from investigation_cache when available. Every briefing
  // load auto-fires this endpoint for top Act Today prospects — without
  // this cache gate, each briefing load burned ~400 SerpAPI searches
  // (10 parcels × 40 searches each) because the server re-ran live
  // gatherSearchResultsV2 every time.
  //
  // The cache gate returns instantly when a cached report exists, and
  // returns a structured "pending" response when it doesn't — preventing
  // ANY live SerpAPI burn from user actions. Fresh investigation only
  // happens during the nightly batch path, which uses investigation_cache
  // with 30-day TTL and does not run redundant searches.
  //
  // Hard rule: this endpoint NEVER runs live SerpAPI searches anymore.
  // If the frontend needs fresh data, it must be generated by the batch.
  // =====================================================================
  
  const { parcelId, zipCode, ownerName, propertyAddress } = req.body;
  
  // ======================================================================
  // HELPER: map investigation_cache.signals[] to the structured evidence
  // shape the frontend renders. Shared by both the cached-deep-signals
  // branch (which has a narrative) and the invCache-only fallback branch
  // (which has structured evidence but no narrative yet).
  // ======================================================================
  
  // Detect obviously-garbage detail strings from noisy investigation
  // extraction. The old extractAllSignals fired entity_info and similar
  // signals on any Google result regardless of relevance, so the raw
  // detail strings often contain unrelated topics stitched together.
  // Filter aggressively — false negatives (dropping a real fact) are
  // much less costly than false positives (showing garbage to agents).
  function looksLikeNoise(text) {
    if (!text || typeof text !== 'string') return true;
    const t = text.toLowerCase();
    // Medical/scientific terms that indicate unrelated results
    if (/\b(cyp2c19|cyp\d|annals of internal medicine|heart rate variability|pubmed|ncbi|genotype|enzyme|nih\.gov|doi:|pmid)\b/i.test(t)) return true;
    // Generic directory / practice listings that aren't about a specific owner
    if (/attorneys and agents registered to practice|matter of attorneys in violation|judiciary law/i.test(t)) return true;
    // LinkedIn directory / browse pages — NOT personal profiles.
    // LinkedIn indexes its directory by alphabet and paginates them, so
    // search results routinely return titles like "People starting with
    // 'J' - Page 2774", "People with the last name Smith", "LinkedIn
    // Members Directory", etc. These are worthless — they're just
    // alphabetical indexes, not profiles about the parcel owner.
    if (/people starting with|people with the (last|first) name|linkedin members? directory|linkedin browse|public profile directory|alphabetical directory/i.test(t)) return true;
    // Page-number pagination markers that indicate directory navigation
    // rather than content. "Page 2774" on its own is obviously not an
    // occupation or a fact.
    if (/\bpage\s+\d{2,}\b/i.test(text) && text.length < 100) return true;
    // URL fragments in the middle of what should be a human fact
    if (/https?:\/\/|www\./.test(t) && text.length < 250) return true;
    // Legal case citation noise without owner context
    if (/\b\d+\s+f\.\s*(2d|3d|supp)\b|\b\d+\s+u\.s\.\s+\d+/i.test(t)) return true;
    // Ellipsis-terminated fragments that are clearly truncated search snippets
    if (/\.\.\.\s*;\s*\w/.test(text) && (text.match(/;/g) || []).length >= 2) return true;
    return false;
  }
  
  // Extract occupation from a LinkedIn result title, defensively.
  // Valid LinkedIn title format: "Name - Title at Company"
  // Invalid examples to reject:
  //   "People starting with 'J' - Page 2774"  (directory)
  //   "Jane Doe - LinkedIn"                    (just the site name)
  //   "Profiles - LinkedIn"                    (browse page)
  //   "Members Directory - LinkedIn"           (browse page)
  // Returns the clean occupation string or null if the title doesn't
  // look like a real profile.
  function extractLinkedInOccupation(titleDetail) {
    if (!titleDetail || typeof titleDetail !== 'string') return null;
    if (looksLikeNoise(titleDetail)) return null;
    const parts = titleDetail.split(/\s+-\s+/);
    if (parts.length < 2) return null;
    const occupation = parts.slice(1).join(' - ').trim();
    // Reject placeholder / non-occupation strings
    if (!occupation || occupation.length < 5) return null;
    if (/^linkedin$|^profiles?$|^members?\s+directory$|^public\s+profile$|^\d+\s+connections?$/i.test(occupation)) return null;
    // Reject page-number noise
    if (/^page\s+\d+$/i.test(occupation)) return null;
    // Occupation should look like a title / role / company, not a number or URL
    if (/^https?:\/\//.test(occupation)) return null;
    if (/^\d+$/.test(occupation)) return null;
    return occupation;
  }
  
  function mapInvCacheToEvidence(invCache) {
    const mappedSignals = [];
    const mappedFacts = [];
    const mappedWhoTheyAre = {};
    const mappedLifeEvents = [];
    
    if (!invCache || !Array.isArray(invCache.signals)) {
      return { mappedSignals, mappedFacts, mappedWhoTheyAre, mappedLifeEvents };
    }
    
    const confLabel = (c) => {
      if (c >= 0.75) return 'high confidence';
      if (c >= 0.55) return 'medium confidence';
      return 'low confidence';
    };
    
    for (const s of invCache.signals) {
      const detail = s.detail || '';
      
      // IDENTITY signals → whoTheyAre + confirmedFacts
      // Critical: the raw investigation_cache has a huge false positive
      // problem on entity_info and business_owner signals. The old
      // extractAllSignals() fired these on any result returned from
      // "SOS Registered Agent" or "Entity Members" searches regardless of
      // whether the result was actually about the parcel owner. Result:
      // many rows have entity_info detail strings like "Attorneys and
      // Agents Registered to Practice...; Heart Rate Variability |
      // Annals of Internal Medicine; CYP2C19; ..." which are completely
      // unrelated Google results concatenated together.
      //
      // Strict filter: reject entity_info entries that look like noise,
      // and reject generic business_owner placeholders that provide
      // zero information. Only surface identity data that can stand
      // up as a useful fact to an agent.
      if (s.category === 'identity') {
        if (s.type === 'linkedin_found') {
          // Use defensive extractor — rejects LinkedIn directory pages,
          // page-number noise, and non-profile titles.
          const occupation = extractLinkedInOccupation(detail);
          if (occupation) {
            mappedWhoTheyAre.occupation = occupation;
            // Only surface as confirmed fact when we were able to extract
            // a real occupation. This avoids showing "LinkedIn: People
            // starting with 'J' - Page 2774" as a fact.
            mappedFacts.push({ text: `LinkedIn: ${detail}` });
          }
          // If extraction failed, silently drop — better to show nothing
          // than a garbage directory page reference.
        } else if (s.type === 'business_owner') {
          // Reject the generic placeholder "Business owner/executive"
          // because it provides zero information. Only use this if the
          // detail contains a SPECIFIC title or company name.
          const meaningful = detail &&
            detail.length > 10 &&
            !/^Business owner\/executive$/i.test(detail.trim()) &&
            !looksLikeNoise(detail);
          if (meaningful) {
            mappedWhoTheyAre.ownership = detail;
          }
          // Do NOT push to confirmedFacts — the label "Business
          // owner/executive" on its own adds no value.
        } else if (s.type === 'entity_info') {
          // Entity filings are the worst offender. The raw detail is
          // typically a semicolon-separated list of unrelated Google
          // result titles. Filter hard:
          //   - reject if detail contains unrelated-topic markers
          //   - reject if detail contains URL fragments
          //   - reject if detail has more than 2 semicolons (multiple
          //     unrelated topics stitched together)
          //   - only keep if it looks like a clean entity filing
          //     reference (e.g. "AZ Corp. Commission filing 2019")
          const cleaned = detail.replace(/^Entity info:\s*/i, '').trim();
          const semicolonCount = (cleaned.match(/;/g) || []).length;
          const looksClean =
            cleaned.length > 5 &&
            cleaned.length < 200 &&
            semicolonCount <= 1 &&
            !looksLikeNoise(cleaned) &&
            !/https?:\/\//.test(cleaned);
          if (looksClean) {
            mappedFacts.push({ text: `Entity filings: ${cleaned.slice(0, 160)}` });
          }
          // Otherwise drop it silently — noise has no place in confirmedFacts
        } else if (s.type === 'retired') {
          mappedSignals.push({
            type: 'positive',
            text: 'LinkedIn shows retirement indicators — strong seller signal',
            confidence: confLabel(s.confidence),
          });
        } else {
          // Unknown identity subtype — only surface if detail is clean
          if (detail && detail.length > 10 && !looksLikeNoise(detail)) {
            mappedFacts.push({ text: detail });
          }
        }
      }
      
      // LIFE EVENT signals → positive signals (these are the gold — the
      // whole reason the product exists. Treat as first-class evidence.)
      else if (s.category === 'life_event') {
        let text = detail;
        let eventType = s.type;
        
        if (s.type === 'retirement' || s.type === 'retired') {
          text = 'Retirement indicators in public records — common trigger for downsizing';
          eventType = 'Retirement';
        } else if (s.type === 'obituary' || s.type === 'death') {
          text = 'Possible death in household detected in obituary records — potential estate sale situation';
          eventType = 'Death in household';
        } else if (s.type === 'divorce') {
          text = 'Divorce indicators in court records — common trigger for forced sale';
          eventType = 'Divorce';
        } else if (s.type === 'relocation') {
          text = 'Relocation indicators on LinkedIn — owner may be moving out of market';
          eventType = 'Relocation';
        } else if (s.type === 'bankruptcy') {
          text = 'Bankruptcy filing detected — financial distress signal';
          eventType = 'Financial distress';
        }
        
        mappedSignals.push({
          type: 'positive',
          text,
          confidence: confLabel(s.confidence),
        });
        mappedLifeEvents.push({ type: eventType, detail: text });
      }
      
      // LISTING signals → positive signals (previously listed = warm lead)
      else if (s.category === 'listing') {
        if (s.type === 'previously_listed') {
          mappedSignals.push({
            type: 'positive',
            text: 'Property was previously listed but withdrawn or expired — owner showed intent to sell',
            confidence: confLabel(s.confidence),
          });
        } else if (s.type === 'price_history') {
          mappedSignals.push({
            type: 'positive',
            text: 'Price reductions in listing history — motivated seller pattern',
            confidence: confLabel(s.confidence),
          });
        } else if (s.type === 'extended_dom') {
          mappedSignals.push({
            type: 'positive',
            text: 'Extended time on market — softening price expectations',
            confidence: confLabel(s.confidence),
          });
        } else if (s.type === 'pending_sale') {
          mappedSignals.push({
            type: 'risk',
            text: 'Possibly under contract — may already be in transaction',
            confidence: confLabel(s.confidence),
          });
        }
      }
      
      // BLOCKER signals → risk flags
      else if (s.category === 'blocker') {
        mappedSignals.push({
          type: 'risk',
          text: detail || `Blocker: ${s.type}`,
          confidence: confLabel(s.confidence),
        });
      }
      
      // FINANCIAL signals → positive signal only. We intentionally skip
      // pushing the raw detail string as a "confirmed fact" because it's
      // usually just "Financial distress" — a duplicate of what the
      // positive signal already says. Agents don't need to see the same
      // thing twice.
      else if (s.category === 'financial') {
        if (s.type === 'financial_distress' || s.type === 'bankruptcy') {
          mappedSignals.push({
            type: 'positive',
            text: 'Financial distress indicators detected — motivated seller candidate',
            confidence: confLabel(s.confidence),
          });
        }
      }
    }
    
    // enhanced_claims.demographicSignals → confirmed facts (noise-filtered)
    if (invCache.enhanced_claims && Array.isArray(invCache.enhanced_claims.demographicSignals)) {
      for (const d of invCache.enhanced_claims.demographicSignals) {
        if (d && typeof d === 'string' && d.length > 5 && d.length < 200 && !looksLikeNoise(d)) {
          mappedFacts.push({ text: d });
        }
      }
    }
    
    return { mappedSignals, mappedFacts, mappedWhoTheyAre, mappedLifeEvents };
  }
  
  // Gate 1: If we have a parcelId, look up cached deep signal directly.
  // This is the fast path — most callers go through here.
  if (parcelId && supabase) {
    try {
      const { data: cachedDS } = await supabase
        .from('deep_signals')
        .select('*')
        .eq('parcel_id', parcelId)
        .maybeSingle();
      
      // ALSO fetch the investigation_cache row with structured research data.
      // deep_signals only stores the LLM-generated narrative — the raw
      // structured evidence (life events, LinkedIn profiles, entity filings,
      // confirmed facts) lives in investigation_cache from the investigation
      // engine. We join them here so the frontend can render structured
      // sections (WHO THEY ARE, LIFE EVENTS, CONFIRMED FACTS, POSITIVE
      // SIGNALS, RISK FLAGS) that the batch narrative alone cannot provide.
      let invCache = null;
      try {
        const { data: inv } = await supabase
          .from('investigation_cache')
          .select('*')
          .eq('parcel_id', parcelId)
          .maybeSingle();
        // Skip _listingOnly shallow rows — those don't have real research
        if (inv && !(inv.enhanced_claims && inv.enhanced_claims._listingOnly)) {
          invCache = inv;
        }
      } catch (e) {
        // Non-fatal; fall through to narrative-only response
        console.error(`[beta-research] investigation_cache lookup failed for ${parcelId}:`, e.message);
      }
      
      // Map investigation_cache → structured evidence ONCE, used by both branches
      const { mappedSignals, mappedFacts, mappedWhoTheyAre, mappedLifeEvents } = mapInvCacheToEvidence(invCache);
      
      if (cachedDS && cachedDS.report) {
        // Return in the shape the frontend expects. The batch path writes
        // into both the top-level columns AND the report JSONB, so we
        // prefer top-level columns (they're the canonical write path) and
        // fall back to report fields for backward compatibility with
        // older rows.
        const report = cachedDS.report || {};
        
        const responseShape = {
          // Core scoring fields (not populated by batch DS — frontend will
          // keep whatever score it already computed from parcel heuristics)
          sellerLikelihood: report.sellerLikelihood || null,
          offMarketReceptivity: report.offMarketReceptivity || null,
          confidence: report.confidence || null,
          actionability: report.actionability || null,
          
          // Rich content — prefer top-level columns, fall back to report
          motivation: cachedDS.motivation || report.motivation || '',
          timeline: cachedDS.timeline || report.timeline || '',
          best_channel: cachedDS.best_channel || report.best_channel || '',
          call_script: cachedDS.call_script || report.call_script || '',
          mail_script: cachedDS.mail_script || report.mail_script || '',
          door_script: cachedDS.door_script || report.door_script || '',
          what_not_to_say: cachedDS.what_not_to_say || report.what_not_to_say || '',
          
          // Batch DS doesn't populate these legacy fields, but include them
          // as empty so the frontend's optional-chain reads don't error.
          segment: report.segment || null,
          timeframe: cachedDS.timeline || report.timeline || null,
          sellerLikelihoodBasis: cachedDS.motivation || null,
          scoreBasis: cachedDS.motivation || null,
          bestNextMove: cachedDS.best_channel ? 
            (cachedDS.best_channel === 'call' ? 'Phone call' : 
             cachedDS.best_channel === 'mail' ? 'Letter' : 'Door knock') : null,
          scripts: {
            letter: cachedDS.mail_script || '',
            phone: cachedDS.call_script || '',
            door: cachedDS.door_script || '',
            email: '',
            avoid: cachedDS.what_not_to_say || '',
          },
          
          // STRUCTURED EVIDENCE — now populated from investigation_cache
          signals: mappedSignals,
          confirmedFacts: mappedFacts,
          whoTheyAre: mappedWhoTheyAre,
          lifeEvents: mappedLifeEvents,
          howTheyThink: report.howTheyThink || {},
          sellerPsychology: report.sellerPsychology || {},
          metrics: report.metrics || {},
          
          // Flag this as cached/batch-sourced so the frontend can badge accordingly
          _source: 'batch_cache',
          _generatedAt: cachedDS.generated_at,
          _researchGrounded: report.research_grounded === true,
          _hasStructuredEvidence: mappedSignals.length > 0 || mappedFacts.length > 0 || Object.keys(mappedWhoTheyAre).length > 0,
        };
        
        console.log(`[beta-research] cache HIT for parcel ${parcelId} (${mappedSignals.length} signals, ${mappedFacts.length} facts, whoTheyAre=${Object.keys(mappedWhoTheyAre).length})`);
        return res.json(responseShape);
      }
      
      // ======================================================================
      // FALLBACK: no deep_signals row yet, but investigation_cache exists
      // with real structured evidence. This happens when the new scoring
      // function promotes a parcel into top rank that the old nightly cron
      // never investigated in its "top 5" — research was done for it in a
      // prior run but the LLM narrative + scripts synthesis hasn't happened.
      //
      // ON-DEMAND SYNTHESIS: when the user clicks into a card, we run the
      // Claude synthesis RIGHT NOW using the same prompt worker.js uses in
      // the nightly cron. Cost per call: ~$0.02 and ~3 seconds. We then
      // write the result to deep_signals so subsequent hits use the cache.
      //
      // On synthesis failure (API down, timeout, parse error), fall through
      // to the structured-evidence-only response so the user still sees
      // positive signals and confirmed facts even without narrative.
      // ======================================================================
      if (invCache && (mappedSignals.length > 0 || mappedFacts.length > 0 || Object.keys(mappedWhoTheyAre).length > 0)) {
        // Look up parcel metadata for the prompt
        let parcelMeta = null;
        try {
          const { data: parcelRow } = await supabase
            .from('parcels')
            .select('owner_name, address, zip_code, assessed_value, mailing_address, mailing_city, mailing_state, tenure_years, is_absentee, is_out_of_state, prop_type')
            .eq('id', parcelId)
            .maybeSingle();
          parcelMeta = parcelRow;
        } catch (e) {
          console.error(`[beta-research] parcel meta lookup failed:`, e.message);
        }
        
        let scoreRow = null;
        try {
          const { data: sRow } = await supabase
            .from('parcel_scores')
            .select('seller_likelihood, off_market_receptivity, actionability, confidence, briefing_rank, cohort')
            .eq('parcel_id', parcelId)
            .maybeSingle();
          scoreRow = sRow;
        } catch (e) {
          // non-fatal
        }
        
        // Attempt on-demand synthesis using the same prompt structure as
        // worker.js's Deep Signal batch path. We reuse investigation_cache
        // signals directly so this is zero additional SerpAPI cost.
        let synthesized = null;
        if (anthropic && parcelMeta) {
          try {
            // CRITICAL: build the research block from the noise-filtered
            // mapped data, NOT the raw enhanced_claims. Raw enhanced_claims
            // still contains noise like "People starting with 'J' - Page
            // 2774" and "Entity info: CYP2C19" which would poison the LLM
            // synthesis and produce fabricated "President and CEO with
            // dental background" narratives.
            //
            // mappedSignals is category-clean positive/risk text.
            // mappedFacts has already dropped noise strings.
            // mappedWhoTheyAre has already had bogus occupations rejected.
            const lifeEventLines = mappedLifeEvents
              .map(le => `  - ${le.type}: ${le.detail}`)
              .join('\n');
            const signalLines = mappedSignals
              .filter(s => s.type === 'positive')
              .map(s => `  - ${s.text} (${s.confidence || 'medium'})`)
              .join('\n');
            const riskLines = mappedSignals
              .filter(s => s.type === 'risk')
              .map(s => `  ⚠ ${s.text}`)
              .join('\n');
            const factLines = mappedFacts
              .map(f => `  - ${typeof f === 'string' ? f : f.text || ''}`)
              .filter(line => line.trim().length > 3)
              .join('\n');
            const whoLines = Object.entries(mappedWhoTheyAre)
              .map(([k, v]) => `  - ${k}: ${v}`)
              .join('\n');
            
            const researchBlock = [
              signalLines && `  POSITIVE SIGNALS:\n${signalLines}`,
              lifeEventLines && `  LIFE EVENTS:\n${lifeEventLines}`,
              whoLines && `  WHO THEY ARE:\n${whoLines}`,
              factLines && `  CONFIRMED FACTS:\n${factLines}`,
              riskLines && `  RISKS:\n${riskLines}`,
            ].filter(Boolean).join('\n');
            
            // If the entire mapped evidence is empty after filtering,
            // there's nothing for the LLM to ground on. Skip synthesis
            // and fall through to the structured-evidence-only response
            // (which will also be empty — caller handles this).
            if (!researchBlock.trim()) {
              console.log(`[beta-research] skipping synthesis for ${parcelId} — no clean research after noise filter`);
              throw new Error('no clean research data after filtering');
            }
            
            const signalTypes = (invCache.signals || [])
              .map(s => s.type)
              .filter(Boolean);
            const rankStr = scoreRow?.briefing_rank != null ? `Heuristic score: ${scoreRow.briefing_rank}` : '';
            const cohortStr = scoreRow?.cohort || '';
            
            const promptSection = `[1] ${parcelMeta.owner_name || '?'} — ${parcelMeta.address || '?'}, ${parcelMeta.mailing_city || ''} ${parcelMeta.mailing_state || ''}
  Cohort: ${cohortStr} | $${(parcelMeta.assessed_value||0).toLocaleString()} | Mail: ${parcelMeta.mailing_address||'?'}
  Tenure: ${parcelMeta.tenure_years!=null?parcelMeta.tenure_years+'yr':'?'} | ${rankStr}
  VERIFIED RESEARCH (noise-filtered):
${researchBlock}`;
            
            const synthPromise = anthropic.messages.create({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 2500,
              messages: [{ role: 'user', content: `You are SellerSignal's Deep Signal engine. You produce grounded psychological profiles and outreach strategies for real estate prospects.

CRITICAL DATA HONESTY RULES:
1. GROUND every claim in the VERIFIED RESEARCH block below. Reference specific findings by exact phrasing. If the research says "Retirement indicators in public records", say "public records suggest recent retirement" — not "she's contemplating life changes."
2. DO NOT fabricate occupations, degrees, universities, company names, titles, or personal history that aren't explicitly in the research block. If you don't see it in VERIFIED RESEARCH, it doesn't exist for this person.
3. DO NOT invent specifics. Phrases like "his University of Washington dental background", "his role as CEO of [company]", "her 25-year career at [firm]" are FABRICATIONS unless those exact facts appear in the research. Prefer vague-but-honest ("the owner's professional background") over specific-but-fabricated.
4. Cohort-only prospects (trust + absentee + long tenure with no life events) deserve honest acknowledgment. Say "limited public research surface — analysis based on ownership structure alone" and write generic but respectful scripts. DO NOT invent life events to fill narrative space.
5. The WHO THEY ARE block contains the ONLY verified occupation/ownership info. If a field isn't there, do not make one up.

OUTPUT FORMAT:
Respond with ONLY a JSON object (no array, no code fence). Keys:
{
  "motivation": "3-5 sentences grounded STRICTLY in the VERIFIED RESEARCH block. Reference at least 2 specific findings by name. If research is thin, say so honestly.",
  "timeline": "0-3 months | 3-6 months | 6-12 months | 12+ months",
  "best_channel": "call | mail | door",
  "call_script": "Full 4-6 sentence phone script. Reference specific verified findings naturally. No fabrication.",
  "mail_script": "Full 4-6 sentence letter. Same grounding rules.",
  "door_script": "Full 4-6 sentence door knock. Same grounding rules.",
  "what_not_to_say": "2-3 specific things to avoid, tied to what research actually reveals. Not generic 'do not be pushy.'",
  "research_grounded": true
}

PROSPECT:
${promptSection}` }]
            });
            
            const synthResult = await Promise.race([
              synthPromise,
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000))
            ]);
            
            const raw = (synthResult.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
            synthesized = JSON.parse(raw);
            console.log(`[beta-research] on-demand synthesis OK for ${parcelId}`);
            
            // Save to deep_signals so subsequent hits use the cache
            try {
              await supabase.from('deep_signals').upsert({
                parcel_id: parcelId,
                zip_code: parcelMeta.zip_code || '',
                report: synthesized,
                motivation: synthesized.motivation || null,
                timeline: synthesized.timeline || null,
                best_channel: synthesized.best_channel || null,
                call_script: synthesized.call_script || null,
                mail_script: synthesized.mail_script || null,
                door_script: synthesized.door_script || null,
                what_not_to_say: synthesized.what_not_to_say || null,
                generated_at: new Date().toISOString()
              }, { onConflict: 'parcel_id' });
            } catch (e) {
              console.error(`[beta-research] deep_signals write failed for ${parcelId}:`, e.message);
              // Non-fatal — we still return the fresh synthesis
            }
          } catch (e) {
            console.error(`[beta-research] on-demand synthesis failed for ${parcelId}:`, e.message);
            // Fall through to structured-evidence-only response
          }
        }
        
        // Build response: if synthesis succeeded, include narrative + scripts.
        // Otherwise return structured evidence alone (still renders cleanly).
        const hasNarrative = !!synthesized;
        const fallbackShape = {
          sellerLikelihood: scoreRow?.seller_likelihood || null,
          offMarketReceptivity: scoreRow?.off_market_receptivity || null,
          confidence: scoreRow?.confidence || null,
          actionability: scoreRow?.actionability || null,
          
          motivation: synthesized?.motivation || '',
          timeline: synthesized?.timeline || '',
          best_channel: synthesized?.best_channel || '',
          call_script: synthesized?.call_script || '',
          mail_script: synthesized?.mail_script || '',
          door_script: synthesized?.door_script || '',
          what_not_to_say: synthesized?.what_not_to_say || '',
          segment: null,
          timeframe: synthesized?.timeline || null,
          sellerLikelihoodBasis: synthesized?.motivation || null,
          scoreBasis: synthesized?.motivation || null,
          bestNextMove: synthesized?.best_channel
            ? (synthesized.best_channel === 'call' ? 'Phone call' :
               synthesized.best_channel === 'mail' ? 'Letter' : 'Door knock')
            : null,
          scripts: {
            letter: synthesized?.mail_script || '',
            phone: synthesized?.call_script || '',
            door: synthesized?.door_script || '',
            email: '',
            avoid: synthesized?.what_not_to_say || '',
          },
          
          // Structured evidence — always present regardless of synthesis
          signals: mappedSignals,
          confirmedFacts: mappedFacts,
          whoTheyAre: mappedWhoTheyAre,
          lifeEvents: mappedLifeEvents,
          howTheyThink: {},
          sellerPsychology: {},
          metrics: {},
          
          _source: hasNarrative ? 'on_demand_synthesis' : 'invcache_only',
          _generatedAt: new Date().toISOString(),
          _researchGrounded: true,
          _hasStructuredEvidence: true,
          _pendingNarrative: !hasNarrative,
        };
        
        console.log(`[beta-research] ${hasNarrative ? 'on-demand synth' : 'invcache-only'} for ${parcelId} (${mappedSignals.length} signals, ${mappedFacts.length} facts, narrative=${hasNarrative})`);
        return res.json(fallbackShape);
      }
    } catch (e) {
      console.error(`[beta-research] cache lookup failed for ${parcelId}:`, e.message);
      // Fall through to pending response below
    }
  }
  
  // Gate 2: No cached deep signal available. Do NOT run live SerpAPI.
  // Return a structured pending response that tells the frontend to
  // show a placeholder message. The batch will generate this data on
  // the next overnight run.
  console.log(`[beta-research] cache MISS for parcel ${parcelId || '(no id)'} — returning pending response`);
  return res.json({
    _source: 'pending_batch',
    _pending: true,
    motivation: 'Deep Signal will be available after next overnight batch. This prospect has not been investigated yet — research findings are generated for top prospects during the nightly scoring run to control API costs.',
    timeline: null,
    best_channel: null,
    call_script: null,
    mail_script: null,
    door_script: null,
    what_not_to_say: null,
    scripts: { letter: '', phone: '', door: '', email: '', avoid: '' },
    signals: [],
    confirmedFacts: [],
    whoTheyAre: {},
    howTheyThink: {},
    sellerPsychology: {},
    metrics: {},
  });
});

// =====================================================================
// LEGACY /api/beta-research live-research path — RETAINED BUT DISABLED.
// The function body below used to run gatherSearchResultsV2 and burn
// 32-45 SerpAPI searches per request. It has been replaced by the cache
// gate above. We leave the code intact (but unreachable) so we can
// restore it behind a feature flag if the batch path proves insufficient.
// To re-enable: rename the handler above to `betaResearchCacheOnly` and
// change the route back to the legacy path. Do not do this without
// first adding per-user rate limiting and cache-first logic.
// =====================================================================
async function _legacyBetaResearchLivePath_DISABLED(req, res) {
  // Reset daily counter
  if (Date.now() > betaDailyLimit.resetTime) {
    betaDailyLimit.count = 0;
    betaDailyLimit.resetTime = Date.now() + 86400000;
  }
  if (betaDailyLimit.count >= 250) {
    return res.status(429).json({ error: 'Daily limit reached (250 searches). Resets at midnight.' });
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
    const displayName = normalizedForPrompt.searchPrimary || resolvedPrincipal || resolvedOwner || streetAddress;

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
Parcel-data heuristic score (for reference only — score independently from search evidence): ${preliminaryScore || 35}
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

    // Strip hollow signals before caching
    sanitizeDeepSignalResult(result);

    // Cache
    await saveToCache(searchName, propertyAddress, result);
    res.json(result);
  } catch (error) {
    console.error('Beta research error:', error);
    res.status(500).json({ error: error.message || 'Research failed' });
  }
}
// END _legacyBetaResearchLivePath_DISABLED — unreachable after cache-gate refactor.

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

  // =====================================================================
  // CACHE-FIRST: Same treatment as POST /api/beta-research. Check
  // deep_signals by parcelId before doing any live work. SSE endpoint
  // is called only by the older map page (public/sellersignal-map.html)
  // but we gate it the same way to prevent any live SerpAPI burn from
  // user actions regardless of entry point.
  // =====================================================================
  const parcelId = req.query.parcelId || req.query.parcel_id || null;
  if (parcelId && supabase) {
    try {
      const { data: cachedDS } = await supabase
        .from('deep_signals')
        .select('*')
        .eq('parcel_id', parcelId)
        .maybeSingle();
      
      if (cachedDS && cachedDS.report) {
        const report = cachedDS.report || {};
        send('progress', { stage: 'complete', message: 'Loaded from batch cache' });
        send('result', {
          motivation: cachedDS.motivation || report.motivation || '',
          timeline: cachedDS.timeline || report.timeline || '',
          best_channel: cachedDS.best_channel || report.best_channel || '',
          call_script: cachedDS.call_script || report.call_script || '',
          mail_script: cachedDS.mail_script || report.mail_script || '',
          door_script: cachedDS.door_script || report.door_script || '',
          what_not_to_say: cachedDS.what_not_to_say || report.what_not_to_say || '',
          scripts: {
            letter: cachedDS.mail_script || '',
            phone: cachedDS.call_script || '',
            door: cachedDS.door_script || '',
            email: '',
            avoid: cachedDS.what_not_to_say || '',
          },
          _source: 'batch_cache',
          _researchGrounded: report.research_grounded === true,
        });
        return res.end();
      }
      
      // FALLBACK: no deep_signals row but investigation_cache has structured
      // evidence. Same rationale as the POST /api/beta-research fallback —
      // parcels promoted into top rank by the new scoring model may not have
      // had narrative synthesis run on them yet. Render structured evidence
      // from invCache directly so the map page isn't stuck on "pending".
      const { data: inv } = await supabase
        .from('investigation_cache')
        .select('*')
        .eq('parcel_id', parcelId)
        .maybeSingle();
      const invCache = (inv && !(inv.enhanced_claims && inv.enhanced_claims._listingOnly)) ? inv : null;
      
      if (invCache && Array.isArray(invCache.signals) && invCache.signals.length > 0) {
        // Inline mapping — same filtering logic as mapInvCacheToEvidence
        // in the POST handler. Duplicated here to avoid scope refactor.
        const _looksLikeNoise = (text) => {
          if (!text || typeof text !== 'string') return true;
          const t = text.toLowerCase();
          if (/\b(cyp2c19|cyp\d|annals of internal medicine|heart rate variability|pubmed|ncbi|genotype|enzyme|nih\.gov|doi:|pmid)\b/i.test(t)) return true;
          if (/attorneys and agents registered to practice|matter of attorneys in violation|judiciary law/i.test(t)) return true;
          // LinkedIn directory / browse pages — NOT personal profiles
          if (/people starting with|people with the (last|first) name|linkedin members? directory|linkedin browse|public profile directory|alphabetical directory/i.test(t)) return true;
          // Page-number pagination markers
          if (/\bpage\s+\d{2,}\b/i.test(text) && text.length < 100) return true;
          if (/https?:\/\/|www\./.test(t) && text.length < 250) return true;
          if (/\b\d+\s+f\.\s*(2d|3d|supp)\b|\b\d+\s+u\.s\.\s+\d+/i.test(t)) return true;
          if (/\.\.\.\s*;\s*\w/.test(text) && (text.match(/;/g) || []).length >= 2) return true;
          return false;
        };
        
        // Defensive LinkedIn occupation extractor — see mapInvCacheToEvidence
        // for full rationale
        const _extractLinkedInOccupation = (titleDetail) => {
          if (!titleDetail || typeof titleDetail !== 'string') return null;
          if (_looksLikeNoise(titleDetail)) return null;
          const parts = titleDetail.split(/\s+-\s+/);
          if (parts.length < 2) return null;
          const occ = parts.slice(1).join(' - ').trim();
          if (!occ || occ.length < 5) return null;
          if (/^linkedin$|^profiles?$|^members?\s+directory$|^public\s+profile$|^\d+\s+connections?$/i.test(occ)) return null;
          if (/^page\s+\d+$/i.test(occ)) return null;
          if (/^https?:\/\//.test(occ)) return null;
          if (/^\d+$/.test(occ)) return null;
          return occ;
        };
        
        const mappedSignals = [];
        const mappedFacts = [];
        const mappedWhoTheyAre = {};
        const confLabel = (c) => c >= 0.75 ? 'high confidence' : c >= 0.55 ? 'medium confidence' : 'low confidence';
        
        for (const s of invCache.signals) {
          const detail = s.detail || '';
          if (s.category === 'life_event') {
            let text = detail;
            if (s.type === 'retirement' || s.type === 'retired') text = 'Retirement indicators in public records — common trigger for downsizing';
            else if (s.type === 'obituary') text = 'Possible death in household detected in obituary records — potential estate sale situation';
            else if (s.type === 'divorce') text = 'Divorce indicators in court records — common trigger for forced sale';
            else if (s.type === 'relocation') text = 'Relocation indicators on LinkedIn — owner may be moving out of market';
            else if (s.type === 'bankruptcy') text = 'Bankruptcy filing detected — financial distress signal';
            mappedSignals.push({ type: 'positive', text, confidence: confLabel(s.confidence) });
          } else if (s.category === 'listing') {
            if (s.type === 'previously_listed') mappedSignals.push({ type: 'positive', text: 'Property was previously listed but withdrawn or expired — owner showed intent to sell', confidence: confLabel(s.confidence) });
            else if (s.type === 'price_history') mappedSignals.push({ type: 'positive', text: 'Price reductions in listing history — motivated seller pattern', confidence: confLabel(s.confidence) });
            else if (s.type === 'pending_sale') mappedSignals.push({ type: 'risk', text: 'Possibly under contract — may already be in transaction', confidence: confLabel(s.confidence) });
          } else if (s.category === 'financial' && (s.type === 'financial_distress' || s.type === 'bankruptcy')) {
            mappedSignals.push({ type: 'positive', text: 'Financial distress indicators detected — motivated seller candidate', confidence: confLabel(s.confidence) });
          } else if (s.category === 'blocker') {
            mappedSignals.push({ type: 'risk', text: detail || `Blocker: ${s.type}`, confidence: confLabel(s.confidence) });
          } else if (s.category === 'identity') {
            if (s.type === 'business_owner') {
              // Reject generic placeholder
              const meaningful = detail && detail.length > 10 && !/^Business owner\/executive$/i.test(detail.trim()) && !_looksLikeNoise(detail);
              if (meaningful) mappedWhoTheyAre.ownership = detail;
            } else if (s.type === 'linkedin_found') {
              const occ = _extractLinkedInOccupation(detail);
              if (occ) {
                mappedWhoTheyAre.occupation = occ;
                mappedFacts.push({ text: `LinkedIn: ${detail}` });
              }
            } else if (s.type === 'entity_info') {
              const cleaned = detail.replace(/^Entity info:\s*/i, '').trim();
              const semicolonCount = (cleaned.match(/;/g) || []).length;
              const looksClean = cleaned.length > 5 && cleaned.length < 200 && semicolonCount <= 1 && !_looksLikeNoise(cleaned) && !/https?:\/\//.test(cleaned);
              if (looksClean) mappedFacts.push({ text: `Entity filings: ${cleaned.slice(0, 160)}` });
            }
          }
        }
        
        send('progress', { stage: 'complete', message: 'Loaded structured evidence from research cache' });
        send('result', {
          motivation: '',
          timeline: '',
          scripts: { letter: '', phone: '', door: '', email: '', avoid: '' },
          signals: mappedSignals,
          confirmedFacts: mappedFacts,
          whoTheyAre: mappedWhoTheyAre,
          _source: 'invcache_only',
          _researchGrounded: true,
          _pendingNarrative: true,
        });
        return res.end();
      }
    } catch (e) {
      console.error(`[beta-research/stream] cache lookup failed:`, e.message);
    }
  }
  
  // Gate 2: No cache. Return pending response and stop.
  send('progress', { stage: 'pending', message: 'Deep Signal not yet generated for this prospect' });
  send('result', {
    _source: 'pending_batch',
    _pending: true,
    motivation: 'Deep Signal will be available after next overnight batch. This prospect has not been investigated yet — research findings are generated for top prospects during the nightly scoring run to control API costs.',
    scripts: { letter: '', phone: '', door: '', email: '', avoid: '' },
  });
  return res.end();
});

// LEGACY SSE live-research handler — RETAINED BUT DISABLED (same treatment
// as the POST /api/beta-research legacy path above). Unreachable. To
// re-enable, wire it back to the route above it.
async function _legacyBetaResearchStreamLivePath_DISABLED(req, res) {
  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Reset daily counter
  if (Date.now() > betaDailyLimit.resetTime) {
    betaDailyLimit.count = 0;
    betaDailyLimit.resetTime = Date.now() + 86400000;
  }
  if (betaDailyLimit.count >= 100) {
    send('error', { error: 'Daily beta limit reached (100 searches).' });
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
      const displayOwner = normalized.searchPrimary || resolvedOwner;
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
    const displayName = normalizedForPrompt.searchPrimary || resolvedPrincipal || resolvedOwner || streetAddress;

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
Parcel-data heuristic score (for reference only — score independently from search evidence): ${preliminaryScore || 35}
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

    // Strip hollow signals before sending + caching
    sanitizeDeepSignalResult(result);

    send('progress', { stage: 'complete', message: 'Deep Signal complete' });
    send('result', result);

    await saveToCache(searchName, propertyAddress, result);
  } catch (error) {
    console.error('SSE research error:', error);
    send('error', { error: error.message || 'Research failed' });
  }
  res.end();
}
// END _legacyBetaResearchStreamLivePath_DISABLED

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
  const secret = req.query.key;
  if (!process.env.ADMIN_KEY || secret !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.json({ status: 'No cache configured' });
  await supabase.from('signals_cache').delete().neq('cache_key', '');
  res.json({ status: 'Cache cleared' });
});

// ===================
// PERSISTENCE LAYER — V2A data accumulation
// ===================

// POST /api/persist/briefing — save a complete briefing run
app.post('/api/persist/briefing', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  
  try {
    const { zipCode, agentId, prospects, stats } = req.body;
    if (!zipCode || !prospects) return res.status(400).json({ error: 'zipCode and prospects required' });
    
    const today = new Date().toISOString().split('T')[0];
    
    // 1. Save briefing run
    const { data: briefingRun } = await supabase.from('briefing_run').insert({
      agent_id: agentId || null,
      zip_code: zipCode,
      parcels_loaded: stats?.parcelsLoaded || 0,
      parcels_scored: stats?.parcelsScored || 0,
      act_today_count: stats?.actToday || 0,
      outreach_count: stats?.outreach || 0,
      watch_count: stats?.watch || 0,
      serpapi_searches: stats?.serpApiSearches || 0,
      anthropic_calls: stats?.anthropicCalls || 0,
      duration_seconds: stats?.duration || 0
    }).select().single();
    
    // 2. Save parcel snapshots + intelligence results (batch)
    const snapshots = [];
    const intelligenceResults = [];
    const transferLabels = [];
    
    for (const p of prospects.slice(0, 300)) {
      // Snapshot
      snapshots.push({
        parcel_id: p.id || `${p.lat}-${p.lng}`,
        zip_code: zipCode,
        source_key: p._sourceKey || null,
        snapshot_date: today,
        owner_name_raw: p.ownerName || null,
        owner_type: p.ownerType || null,
        situs_address: p.address || null,
        situs_city: p.cityStateZip ? p.cityStateZip.split(',')[0]?.trim() : null,
        mailing_address: p.ownerAddress || null,
        mailing_city: p.ownerCity || null,
        mailing_state: p.ownerState || null,
        mailing_zip: p.ownerZip || null,
        is_absentee: p.isAbsentee || false,
        is_out_of_state: p.isOutOfState || false,
        is_vacant_land: p.isVacantLand || false,
        has_building_value: (p.buildingValue || 0) > 0,
        total_value: p.totalValue || null,
        land_value: p.landValue || null,
        building_value: p.buildingValue || null,
        property_type: p.propType || null,
        acres: p.acres || null,
        year_built: p.yearBuilt || null,
        sqft: p.sqft || null,
        subdivision: p.subdivision || null,
        last_transfer_date: p.lastTransferDate || null,
        last_transfer_year: p.lastTransferYear || null,
        tenure_years: p.tenureYears || null,
        sale_price: p.salePrice || null,
        seller_likelihood: p.sellerLikelihood || null,
        off_market_receptivity: p.offMarketReceptivity || null,
        actionability: p.actionability || null,
        confidence: p.confidence || null,
        briefing_rank: p.briefingRank || null,
        tier: p._tier || null,
        latitude: p.lat || null,
        longitude: p.lng || null
      });
      
      // Intelligence result
      intelligenceResults.push({
        parcel_id: p.id || `${p.lat}-${p.lng}`,
        subject_id: p.ownerName || null,
        briefing_date: today,
        zip_code: zipCode,
        agent_id: agentId || null,
        seller_likelihood: p.sellerLikelihood || null,
        off_market_receptivity: p.offMarketReceptivity || null,
        actionability: p.actionability || null,
        confidence: p.confidence || null,
        briefing_rank: p.briefingRank || null,
        tier: p._tier || null,
        score_class: p.scoreClass || null,
        signals: p.signals || null,
        claims_total: p._claimSummary?.total || 0,
        claims_accepted: p._claimSummary?.accepted || 0,
        claims_weak: p._claimSummary?.weak || 0,
        gaps: p._searchPlan?.map(s => s.reason) || null,
        life_events: p._lifeEvents || null,
        person_profile: p._personProfile || null,
        deep_signal_run: p._deepSignalVerified || false,
        deep_signal_data: p._deepSignal || null
      });
      
      // Transfer outcome label (empty — filled in later by background job)
      transferLabels.push({
        parcel_id: p.id || `${p.lat}-${p.lng}`,
        snapshot_date: today,
        zip_code: zipCode,
        original_seller_likelihood: p.sellerLikelihood || null,
        original_tier: p._tier || null,
        original_owner_type: p.ownerType || null,
        original_tenure_years: p.tenureYears || null,
        original_is_absentee: p.isAbsentee || false,
        original_is_out_of_state: p.isOutOfState || false
      });
    }
    
    // Batch upsert (ignore duplicates on same parcel+date)
    const batchSize = 100;
    for (let i = 0; i < snapshots.length; i += batchSize) {
      await supabase.from('parcel_snapshot').upsert(
        snapshots.slice(i, i + batchSize),
        { onConflict: 'parcel_id,snapshot_date', ignoreDuplicates: true }
      );
    }
    for (let i = 0; i < intelligenceResults.length; i += batchSize) {
      await supabase.from('intelligence_result').insert(
        intelligenceResults.slice(i, i + batchSize)
      );
    }
    for (let i = 0; i < transferLabels.length; i += batchSize) {
      await supabase.from('transfer_outcome_label').upsert(
        transferLabels.slice(i, i + batchSize),
        { onConflict: 'parcel_id,snapshot_date', ignoreDuplicates: true }
      );
    }
    
    console.log(`Persisted briefing: ${zipCode} — ${snapshots.length} snapshots, ${intelligenceResults.length} results`);
    res.json({ 
      success: true, 
      briefingRunId: briefingRun?.id,
      snapshotCount: snapshots.length,
      resultCount: intelligenceResults.length
    });
    
  } catch (error) {
    console.error('Persist briefing error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.options('/api/persist/briefing', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(204);
});

// POST /api/snapshot/diff — compare current parcels against prior snapshots
// Returns owner changes and mailing changes for claim generation
app.post('/api/snapshot/diff', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.json({ diffs: [] });
  
  try {
    const { parcels } = req.body;
    if (!parcels || !Array.isArray(parcels) || parcels.length === 0) {
      return res.json({ diffs: [] });
    }
    
    const batch = parcels.slice(0, 500);
    const parcelIds = batch.map(p => p.id).filter(Boolean);
    
    if (parcelIds.length === 0) return res.json({ diffs: [] });
    
    // Get most recent prior snapshot for each parcel
    const { data: priorSnapshots, error } = await supabase
      .from('parcel_snapshot')
      .select('parcel_id, owner_name_raw, mailing_address, total_value, is_absentee, snapshot_date')
      .in('parcel_id', parcelIds)
      .lt('snapshot_date', new Date().toISOString().split('T')[0])
      .order('snapshot_date', { ascending: false });
    
    if (error) throw error;
    
    // Build lookup: most recent snapshot per parcel
    const priorMap = {};
    for (const snap of (priorSnapshots || [])) {
      if (!priorMap[snap.parcel_id]) {
        priorMap[snap.parcel_id] = snap; // first result is most recent due to ORDER DESC
      }
    }
    
    // Compare
    const diffs = [];
    for (const current of batch) {
      const prior = priorMap[current.id];
      if (!prior) continue; // no prior snapshot, nothing to diff
      
      const normCurrent = (current.ownerName || '').toUpperCase().trim().replace(/\s+/g, ' ');
      const normPrior = (prior.owner_name_raw || '').toUpperCase().trim().replace(/\s+/g, ' ');
      
      const normMailCurrent = (current.ownerAddress || '').toUpperCase().trim().replace(/\s+/g, ' ');
      const normMailPrior = (prior.mailing_address || '').toUpperCase().trim().replace(/\s+/g, ' ');
      
      const ownerChanged = normCurrent.length > 2 && normPrior.length > 2 && normCurrent !== normPrior;
      const mailingChanged = normMailCurrent.length > 3 && normMailPrior.length > 3 && normMailCurrent !== normMailPrior;
      
      const valuePrev = prior.total_value || 0;
      const valueCurrent = current.totalValue || 0;
      const valueChanged = valuePrev > 0 && valueCurrent > 0 && Math.abs(valueCurrent - valuePrev) / valuePrev > 0.10;
      const valueDecreased = valueChanged && valueCurrent < valuePrev;
      
      const absenteeChanged = current.isAbsentee !== prior.is_absentee;
      const becameAbsentee = absenteeChanged && current.isAbsentee === true;
      
      const daysSinceLast = Math.floor((Date.now() - new Date(prior.snapshot_date).getTime()) / (24 * 60 * 60 * 1000));
      
      if (ownerChanged || mailingChanged || valueDecreased || becameAbsentee) {
        diffs.push({
          parcelId: current.id,
          ownerChanged,
          mailingChanged,
          valueDecreased,
          becameAbsentee,
          prevOwner: prior.owner_name_raw,
          currentOwner: current.ownerName,
          prevMailing: prior.mailing_address,
          currentMailing: current.ownerAddress,
          daysSinceLast,
          snapshotDate: prior.snapshot_date
        });
      }
    }
    
    console.log(`Snapshot diff: ${batch.length} parcels checked, ${diffs.length} changes detected`);
    res.json({ diffs, checked: batch.length });
    
  } catch (error) {
    console.error('Snapshot diff error:', error);
    res.json({ diffs: [], error: error.message });
  }
});

app.options('/api/snapshot/diff', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// POST /api/persist/claims — save claims for a specific prospect
app.post('/api/persist/claims', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  
  try {
    const { claims } = req.body;
    if (!claims || !Array.isArray(claims)) return res.status(400).json({ error: 'claims array required' });
    
    const rows = claims.slice(0, 500).map(c => ({
      parcel_id: c.parcelId,
      subject_id: c.subjectId || null,
      briefing_date: new Date().toISOString().split('T')[0],
      claim_type: c.claimType,
      claim_value: c.value || null,
      source: c.source,
      source_confidence: c.sourceConfidence || null,
      match_confidence: c.matchConfidence || null,
      freshness_days: c.freshnessDays || 0,
      accepted: c.accepted || false,
      accepted_reason: c.acceptedReason || null
    }));
    
    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      await supabase.from('claim').insert(rows.slice(i, i + batchSize));
    }
    
    res.json({ success: true, count: rows.length });
  } catch (error) {
    console.error('Persist claims error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.options('/api/persist/claims', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(204);
});

// POST /api/persist/contact — log agent contact with a lead
app.post('/api/persist/contact', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  
  try {
    const { parcelId, agentId, channel, result, notes, followUpDate } = req.body;
    if (!parcelId) return res.status(400).json({ error: 'parcelId required' });
    
    const { data } = await supabase.from('contact_outcome').insert({
      parcel_id: parcelId,
      agent_id: agentId || null,
      channel: channel || null,
      result: result || null,
      notes: notes || null,
      follow_up_date: followUpDate || null
    }).select().single();
    
    res.json({ success: true, id: data?.id });
  } catch (error) {
    console.error('Persist contact error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.options('/api/persist/contact', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(204);
});

// GET /api/persist/contacts — read all contacts for an agent (or all if no agentId)
app.get('/api/persist/contacts', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.json({ contacts: {} });
  
  try {
    const agentId = req.query.agentId || null;
    let query = supabase.from('contact_outcome')
      .select('*')
      .order('contact_date', { ascending: false })
      .limit(500);
    
    if (agentId) query = query.eq('agent_id', agentId);
    
    const { data, error } = await query;
    if (error) throw error;
    
    // Group by parcel_id for CRM consumption
    const grouped = {};
    for (const row of (data || [])) {
      if (!grouped[row.parcel_id]) grouped[row.parcel_id] = [];
      grouped[row.parcel_id].push({
        id: row.id,
        date: row.contact_date,
        channel: row.channel,
        result: row.result,
        notes: row.notes,
        followUpDate: row.follow_up_date,
        followUpDone: row.follow_up_done
      });
    }
    
    res.json({ contacts: grouped });
  } catch (error) {
    console.error('Read contacts error:', error);
    res.json({ contacts: {} });
  }
});

// GET /api/persist/follow-ups — get leads with pending follow-ups
app.get('/api/persist/follow-ups', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.json({ followUps: [] });
  
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase
      .from('contact_outcome')
      .select('*')
      .lte('follow_up_date', today)
      .eq('follow_up_done', false)
      .not('follow_up_date', 'is', null)
      .order('follow_up_date', { ascending: true })
      .limit(100);
    
    if (error) throw error;
    
    res.json({ followUps: data || [] });
  } catch (error) {
    console.error('Follow-ups error:', error);
    res.json({ followUps: [] });
  }
});

app.options('/api/persist/contacts', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.options('/api/persist/follow-ups', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// POST /api/persist/behavior — log agent behavior event
app.post('/api/persist/behavior', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  
  try {
    const { agentId, sessionId, eventType, parcelId, zipCode, tier, briefingRank, metadata } = req.body;
    if (!eventType) return res.status(400).json({ error: 'eventType required' });
    
    await supabase.from('agent_behavior').insert({
      agent_id: agentId || null,
      session_id: sessionId || null,
      event_type: eventType,
      parcel_id: parcelId || null,
      zip_code: zipCode || null,
      tier: tier || null,
      briefing_rank: briefingRank || null,
      metadata: metadata || null
    });
    
    res.json({ success: true });
  } catch (error) {
    // Don't fail the UX over analytics
    res.json({ success: false });
  }
});

app.options('/api/persist/behavior', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(204);
});

// GET /api/zip-availability — check which ZIPs are claimed
app.get('/api/zip-availability', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.json({ claimed: [] });
  
  try {
    const { data } = await supabase
      .from('zip_claim')
      .select('zip_code, status')
      .eq('status', 'active');
    
    res.json({ claimed: (data || []).map(d => d.zip_code) });
  } catch (error) {
    res.json({ claimed: [] });
  }
});

// ===================
// BACKGROUND LABELER — check if scored parcels actually transferred
// ===================

// Source configs for re-querying current owner
const LABELER_SOURCES = {
  MT: { 
    url: 'https://gis.dnrc.mt.gov/arcgis/rest/services/Cadastral/Cadastral/MapServer/1/query',
    ownerField: 'OwnerName', idField: 'PARCELID'
  },
  WA_KING: {
    url: 'https://gismaps.kingcounty.gov/arcGIS/rest/services/Property/KingCo_Parcels/MapServer/0/query',
    ownerField: 'TAXPAYER_NAME', idField: 'PIN'
  },
  NY: {
    url: 'https://services6.arcgis.com/DZHaqZm9elBmSjkY/arcgis/rest/services/Parcels_Public/FeatureServer/0/query',
    ownerField: 'PRIMARY_OWNER', idField: 'SBL'
  },
  TX_BEXAR: {
    url: 'https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0/query',
    ownerField: 'Owner', idField: 'AcctNumb'
  },
  AZ_MARICOPA: {
    url: 'https://gis.mcassessor.maricopa.gov/arcgis/rest/services/MaricopaDynamicQueryService/MapServer/3/query',
    ownerField: 'OWNER_NAME', idField: 'APN'
  },
  FL_PB: {
    url: 'https://wpbgisportal.wpb.org/server/rest/services/Parcel/Parcels_New/FeatureServer/0/query',
    ownerField: 'OWNER_NAME1', idField: 'OBJECTID'
  }
};

function normalizeOwnerForComparison(name) {
  if (!name) return '';
  return name.toUpperCase()
    .replace(/[.,;:'"!?#\-()\/\\]/g, '')
    .replace(/\bLLC\b|\bINC\b|\bCORP\b|\bLTD\b/g, '')
    .replace(/\bTRUST\b|\bTRUSTEE\b|\bTRSTEE\b/g, 'TRUST')
    .replace(/\s+/g, ' ')
    .trim();
}

// Query current owner by spatial location
async function queryCurrentOwner(sourceKey, lat, lng) {
  const src = LABELER_SOURCES[sourceKey];
  if (!src) return null;
  
  try {
    // Small buffer around point (about 30m)
    const buffer = 0.0003;
    const geom = JSON.stringify({
      xmin: lng - buffer, ymin: lat - buffer,
      xmax: lng + buffer, ymax: lat + buffer,
      spatialReference: { wkid: 4326 }
    });
    
    const params = new URLSearchParams({
      geometry: geom,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: [src.ownerField, src.idField].filter(Boolean).join(','),
      returnGeometry: 'false',
      f: 'json',
      resultRecordCount: '1'
    });
    
    // Maricopa needs returnGeometry=false
    if (sourceKey === 'AZ_MARICOPA') params.set('returnGeometry', 'false');
    
    const resp = await fetch(`${src.url}?${params}`, { 
      signal: AbortSignal.timeout(10000) 
    });
    const data = await resp.json();
    
    if (data.features && data.features.length > 0) {
      const attrs = data.features[0].attributes;
      return attrs[src.ownerField] || null;
    }
    return null;
  } catch(e) {
    return null;
  }
}

// POST /api/label/check-transfers — check a batch of snapshots for ownership changes
app.post('/api/label/check-transfers', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  
  try {
    const { batchSize = 50, minAgeDays = 30 } = req.body || {};
    
    // Get snapshots that haven't been checked recently
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - minAgeDays);
    
    const { data: snapshots, error } = await supabase
      .from('parcel_snapshot')
      .select('parcel_id, snapshot_date, source_key, owner_name_raw, zip_code, tier, seller_likelihood, owner_type, tenure_years, is_absentee, is_out_of_state, latitude, longitude')
      .lte('snapshot_date', cutoffDate.toISOString().split('T')[0])
      .order('snapshot_date', { ascending: true })
      .limit(batchSize);
    
    if (error) throw error;
    if (!snapshots || snapshots.length === 0) {
      return res.json({ checked: 0, transfers: 0, message: 'No snapshots old enough to check' });
    }
    
    // Check which ones already have labels
    const parcelIds = snapshots.map(s => s.parcel_id);
    const { data: existingLabels } = await supabase
      .from('transfer_outcome_label')
      .select('parcel_id, snapshot_date, last_checked')
      .in('parcel_id', parcelIds);
    
    const labelMap = {};
    for (const l of (existingLabels || [])) {
      labelMap[`${l.parcel_id}_${l.snapshot_date}`] = l;
    }
    
    // Filter to those not checked in last 7 days
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const toCheck = snapshots.filter(s => {
      const key = `${s.parcel_id}_${s.snapshot_date}`;
      const existing = labelMap[key];
      if (!existing) return true;
      if (!existing.last_checked) return true;
      return new Date(existing.last_checked).getTime() < weekAgo;
    });
    
    console.log(`Transfer labeler: ${toCheck.length} of ${snapshots.length} snapshots to check`);
    
    let transfers = 0;
    let checked = 0;
    let failed = 0;
    
    // Process in batches of 5 (to not hammer GIS endpoints)
    for (let i = 0; i < toCheck.length; i += 5) {
      const batch = toCheck.slice(i, i + 5);
      
      const results = await Promise.allSettled(batch.map(async (snap) => {
        // Use stored lat/lng first, fall back to parsing parcel_id for legacy data
        let lat = snap.latitude || null;
        let lng = snap.longitude || null;
        
        if (!lat || !lng) {
          const parts = snap.parcel_id.split('-');
          if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            lat = parseFloat(parts[0]);
            lng = parseFloat(parts[1]);
            if (!(lat > 20 && lat < 50 && lng < -60 && lng > -130)) { lat = null; lng = null; }
          }
        }
        
        // Need lat/lng to do spatial query
        if (!lat || !lng || !snap.source_key) return { snap, currentOwner: null, error: 'no_location' };
        
        const currentOwner = await queryCurrentOwner(snap.source_key, lat, lng);
        return { snap, currentOwner };
      }));
      
      for (const r of results) {
        if (r.status !== 'fulfilled') { failed++; continue; }
        const { snap, currentOwner, error: queryError } = r.value;
        
        if (queryError || !currentOwner) { failed++; continue; }
        checked++;
        
        const snapOwner = normalizeOwnerForComparison(snap.owner_name_raw);
        const currOwner = normalizeOwnerForComparison(currentOwner);
        
        const ownerChanged = snapOwner && currOwner && snapOwner !== currOwner;
        
        if (ownerChanged) {
          transfers++;
          console.log(`  Transfer detected: ${snap.parcel_id} — ${snap.owner_name_raw} → ${currentOwner}`);
        }
        
        // Calculate months since snapshot
        const snapDate = new Date(snap.snapshot_date);
        const monthsSince = Math.floor((Date.now() - snapDate.getTime()) / (30 * 24 * 60 * 60 * 1000));
        
        // Update transfer_outcome_label
        const labelUpdate = {
          parcel_id: snap.parcel_id,
          snapshot_date: snap.snapshot_date,
          zip_code: snap.zip_code,
          last_checked: new Date().toISOString(),
          check_source: 'gis_owner_compare',
          original_seller_likelihood: snap.seller_likelihood,
          original_tier: snap.tier,
          original_owner_type: snap.owner_type,
          original_tenure_years: snap.tenure_years,
          original_is_absentee: snap.is_absentee,
          original_is_out_of_state: snap.is_out_of_state
        };
        
        if (ownerChanged) {
          if (monthsSince <= 6) { labelUpdate.sold_within_6m = true; labelUpdate.sold_within_12m = true; labelUpdate.sold_within_24m = true; }
          else if (monthsSince <= 12) { labelUpdate.sold_within_6m = false; labelUpdate.sold_within_12m = true; labelUpdate.sold_within_24m = true; }
          else if (monthsSince <= 24) { labelUpdate.sold_within_6m = false; labelUpdate.sold_within_12m = false; labelUpdate.sold_within_24m = true; }
        } else {
          if (monthsSince >= 6) labelUpdate.sold_within_6m = false;
          if (monthsSince >= 12) labelUpdate.sold_within_12m = false;
          if (monthsSince >= 24) labelUpdate.sold_within_24m = false;
        }
        
        await supabase.from('transfer_outcome_label').upsert(labelUpdate, { 
          onConflict: 'parcel_id,snapshot_date' 
        });
      }
      
      // Rate limit between batches
      if (i + 5 < toCheck.length) await new Promise(r => setTimeout(r, 500));
    }
    
    console.log(`Transfer labeler: ${checked} checked, ${transfers} transfers, ${failed} failed`);
    res.json({ checked, transfers, failed, total: toCheck.length });
    
  } catch (error) {
    console.error('Transfer labeler error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.options('/api/label/check-transfers', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// GET /api/label/stats — training data accumulation stats
app.get('/api/label/stats', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.json({ error: 'No database' });
  
  try {
    const [snapshots, labels, claims, contacts, briefings] = await Promise.all([
      supabase.from('parcel_snapshot').select('id', { count: 'exact', head: true }),
      supabase.from('transfer_outcome_label').select('id', { count: 'exact', head: true }),
      supabase.from('claim').select('id', { count: 'exact', head: true }),
      supabase.from('contact_outcome').select('id', { count: 'exact', head: true }),
      supabase.from('briefing_run').select('id', { count: 'exact', head: true })
    ]);
    
    // Count labeled outcomes
    const { count: labeledCount } = await supabase
      .from('transfer_outcome_label')
      .select('id', { count: 'exact', head: true })
      .not('last_checked', 'is', null);
    
    const { count: transferCount } = await supabase
      .from('transfer_outcome_label')
      .select('id', { count: 'exact', head: true })
      .eq('sold_within_12m', true);
    
    res.json({
      snapshots: snapshots.count || 0,
      transferLabels: labels.count || 0,
      labeledOutcomes: labeledCount || 0,
      confirmedTransfers: transferCount || 0,
      claims: claims.count || 0,
      contactOutcomes: contacts.count || 0,
      briefingRuns: briefings.count || 0,
      readyForTraining: (labeledCount || 0) >= 500
    });
  } catch(e) {
    res.json({ error: e.message });
  }
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
// BETA FEEDBACK
// ===================

app.post('/api/feedback', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  const { working, confusing, missing, rating, zip, agent, timestamp } = req.body;
  
  const { error } = await supabase.from('beta_feedback').insert({
    agent_id: agent || 'anonymous',
    zip_code: zip || null,
    working: working || null,
    confusing: confusing || null,
    missing: missing || null,
    rating: rating || null,
    submitted_at: timestamp || new Date().toISOString(),
  });
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ saved: true });
});

app.options('/api/feedback', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// ===================
// MICRO FEEDBACK — in-app behavioral signals
// ===================

app.post('/api/micro-feedback', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  const { 
    promptType, response, responseValue, 
    zipCode, prospectId, prospectScore, 
    agentId, agentEmail, sessionId, context 
  } = req.body;
  
  if (!promptType || !response) {
    return res.status(400).json({ error: 'promptType and response required' });
  }
  
  // Skip admin/demo feedback to keep the beta signal clean
  const ADMIN_EMAILS_LIST = ['jeremy@sellersignal.co', 'jeremyseglem@gmail.com', 'jeremy.seglem@theagencyre.com', 'jmseglem@gmail.com', 'brian.hawkins@theagencyre.com'];
  if (agentEmail && ADMIN_EMAILS_LIST.includes(agentEmail.toLowerCase())) {
    return res.json({ saved: false, reason: 'admin_excluded' });
  }
  
  const { error } = await supabase.from('beta_micro_feedback').insert({
    agent_id: agentId || 'anonymous',
    agent_email: agentEmail || null,
    zip_code: zipCode || null,
    prompt_type: promptType,
    response: response,
    response_value: typeof responseValue === 'number' ? responseValue : null,
    prospect_id: prospectId || null,
    prospect_score: typeof prospectScore === 'number' ? prospectScore : null,
    session_id: sessionId || null,
    context: context || null,
  });
  
  if (error) {
    console.error('Micro feedback insert error:', error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json({ saved: true });
});

app.options('/api/micro-feedback', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// ===================
// TERRITORY MANAGEMENT API
// ===================

// GET /api/sale-detections — confirmed sales from previously scored parcels
app.get('/api/sale-detections', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (!supabase) return res.status(503).json({ error: 'Not configured' });
  
  const zip = req.query.zip;
  let query = supabase.from('sale_detections')
    .select('*')
    .order('detected_at', { ascending: false })
    .limit(100);
  if (zip) query = query.eq('zip_code', zip);
  
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  
  const totalValue = (data || []).reduce((s, d) => s + (d.sale_price || 0), 0);
  const totalCommission = Math.round(totalValue * 0.025);
  
  res.json({
    detections: data || [],
    summary: {
      count: (data || []).length,
      totalSaleValue: totalValue,
      estimatedCommission: totalCommission,
    }
  });
});

// ===================
// BATCH PIPELINE API — serves pre-computed briefings from Supabase
// ===================

// GET /api/briefing/:zip — pre-computed briefing for a ZIP
app.get('/api/briefing/:zip', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  
  const { zip } = req.params;
  
  // Get briefing summary
  const { data: briefing, error: bErr } = await supabase
    .from('zip_briefings')
    .select('*')
    .eq('zip_code', zip)
    .single();
  
  if (bErr || !briefing) return res.status(404).json({ error: 'No briefing found for this ZIP.', detail: bErr?.message });
  
  // Get top scored parcels — enough to cover act today + outreach
  const fetchLimit = Math.max(500, (briefing.act_today_count || 0) + (briefing.outreach_queue_count || 0) + 50);
  const { data: scores, error: sErr } = await supabase
    .from('parcel_scores')
    .select('*')
    .eq('zip_code', zip)
    .order('briefing_rank', { ascending: false })
    .limit(fetchLimit);
  
  // Get the parcel details for those scores
  let parcels = [];
  if (scores && scores.length > 0) {
    const ids = scores.map(s => s.parcel_id);
    const { data: parcelData } = await supabase
      .from('parcels')
      .select('*')
      .in('id', ids);
    
    // Merge scores with parcel data
    const parcelMap = new Map((parcelData || []).map(p => [p.id, p]));
    parcels = scores.map(s => ({
      ...s,
      parcel: parcelMap.get(s.parcel_id) || null,
    }));
  }
  
  // Get deep signals for act-today parcels
  const { data: deepSignals } = await supabase
    .from('deep_signals')
    .select('*')
    .eq('zip_code', zip);
  
  res.json({
    briefing,
    parcels: parcels,
    deepSignals: deepSignals || [],
    scoresCount: scores?.length || 0,
    scoresError: sErr?.message || null,
    cached: true,
    computedAt: briefing.computed_at,
  });
});

// GET /api/parcels/:zip — all parcels for a ZIP with scores, optional bounds filter
app.get('/api/parcels/:zip', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  
  const { zip } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
  const offset = parseInt(req.query.offset) || 0;
  const minScore = parseInt(req.query.minScore) || 0;
  const minLat = parseFloat(req.query.minLat) || null;
  const maxLat = parseFloat(req.query.maxLat) || null;
  const minLng = parseFloat(req.query.minLng) || null;
  const maxLng = parseFloat(req.query.maxLng) || null;
  
  // If bounds provided, query parcels table directly (includes unscored parcels)
  if (minLat && maxLat && minLng && maxLng) {
    const { data, error } = await supabase
      .from('parcels')
      .select('id, owner_name, address, city, state, zip_code, lat, lng, assessed_value, owner_type, is_absentee, is_out_of_state, owner_state, mailing_state, tenure_years, prop_type')
      .eq('zip_code', zip)
      .gte('lat', minLat).lte('lat', maxLat)
      .gte('lng', minLng).lte('lng', maxLng)
      .limit(limit);
    
    if (error) return res.status(500).json({ error: error.message });
    res.json({ parcels: data || [] });
    return;
  }
  
  const { data, error, count } = await supabase
    .from('parcel_scores')
    .select('*, parcels(*)', { count: 'exact' })
    .eq('zip_code', zip)
    .gte('briefing_rank', minScore)
    .order('briefing_rank', { ascending: false })
    .range(offset, offset + limit - 1);
  
  if (error) return res.status(500).json({ error: error.message });
  
  res.json({ parcels: data || [], total: count, limit, offset });
});

// GET /api/deep-signal/:parcelId — pre-computed deep signal report
app.get('/api/deep-signal/:parcelId', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  
  const { data, error } = await supabase
    .from('deep_signals')
    .select('*')
    .eq('parcel_id', req.params.parcelId)
    .single();
  
  if (error || !data) return res.status(404).json({ error: 'No deep signal found for this parcel' });
  res.json(data);
});

// GET /api/markets — list all available markets and ZIP codes
app.get('/api/markets', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  
  // Get all briefings to show which ZIPs are processed
  const { data: briefings } = await supabase
    .from('zip_briefings')
    .select('zip_code, market_key, market_name, total_parcels, act_today_count, computed_at');
  
  // Get all territory claims
  const { data: claims } = await supabase
    .from('territory_claims')
    .select('zip_code, status');
  
  const claimedZips = new Set((claims || []).filter(c => c.status === 'active').map(c => c.zip_code));
  
  res.json({
    briefings: (briefings || []).map(b => ({
      ...b,
      claimed: claimedZips.has(b.zip_code),
    })),
  });
});

// POST /api/batch/trigger — trigger batch processing for a ZIP (admin/internal)
app.post('/api/batch/trigger', async (req, res) => {
  const { zip, market } = req.body;
  res.json({ 
    message: `To process ${zip || market || 'all'}, run: node batch/worker.js ${zip ? '--zip ' + zip : market ? '--market ' + market : '--all'}`,
  });
});

// GET /api/batch/start — spawn batch as background process (returns immediately)
// Usage: sellersignal.co/api/batch/start?key=ss_batch_2026 (all ZIPs)
//        sellersignal.co/api/batch/start?key=ss_batch_2026&market=FL_MD
//        sellersignal.co/api/batch/start?key=ss_batch_2026&zip=28207
//        sellersignal.co/api/batch/start?key=ss_batch_2026&noai=1
app.get('/api/batch/start', (req, res) => {
  const BATCH_KEY = process.env.BATCH_SECRET || 'ss_batch_2026';
  if (req.query.key !== BATCH_KEY) return res.status(403).json({ error: 'Invalid batch key' });
  
  const args = [];
  if (req.query.zip) args.push('--zip', req.query.zip);
  else if (req.query.market) args.push('--market', req.query.market);
  else args.push('--all');
  if (req.query.noai === '1') args.push('--noai');
  
  const { spawn } = require('child_process');
  const worker = spawn('node', ['batch/worker.js', ...args], {
    stdio: 'inherit',
    env: process.env,
    detached: true,
  });
  worker.unref(); // let it run independently
  
  worker.on('error', (err) => console.error(`Batch spawn error: ${err.message}`));
  
  res.json({
    started: true,
    command: `node batch/worker.js ${args.join(' ')}`,
    message: 'Batch started in background. Check Railway logs for progress.',
  });
});

// GET /api/batch/run — run batch via browser URL with streaming output
// Uses the standalone worker (shared pipeline) — no duplicated code
// Usage: sellersignal.co/api/batch/run?zip=28207&key=ss_batch_2026
app.get('/api/batch/run', (req, res) => {
  const BATCH_KEY = process.env.BATCH_SECRET || 'ss_batch_2026';
  if (req.query.key !== BATCH_KEY) return res.status(403).json({ error: 'Invalid batch key' });
  
  const workerArgs = [];
  if (req.query.zip) workerArgs.push('--zip', req.query.zip);
  else if (req.query.market) workerArgs.push('--market', req.query.market);
  else workerArgs.push('--all');
  if (req.query.noai === '1') workerArgs.push('--noai');
  
  req.setTimeout(600000);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  
  const { spawn } = require('child_process');
  const worker = spawn('node', ['batch/worker.js', ...workerArgs], {
    env: process.env,
    cwd: process.cwd(),
  });
  
  worker.stdout.on('data', (data) => res.write(data));
  worker.stderr.on('data', (data) => res.write(data));
  worker.on('close', (code) => {
    res.write(`\nProcess exited with code ${code}\n`);
    res.end();
  });
  worker.on('error', (err) => {
    res.write(`\nWorker error: ${err.message}\n`);
    res.end();
  });
  
  req.on('close', () => {
    // Client disconnected — kill the worker
    worker.kill();
  });
});

// ===================
// V2 — FULL-UNIVERSE SELLER-STATE INFERENCE
// ===================

// GET /api/v2/batch/start — trigger v2 inference worker with auto-restart
app.get('/api/v2/batch/start', (req, res) => {
  const BATCH_KEY = process.env.BATCH_SECRET || 'ss_batch_2026';
  if (req.query.key !== BATCH_KEY) return res.status(403).json({ error: 'Invalid batch key' });
  
  const args = [];
  if (req.query.zip) args.push(req.query.zip);
  else args.push('--all');
  if (req.query.noinvest) args.push('--noinvest');
  
  const maxRestarts = parseInt(req.query.maxRestarts) || 20;
  let restartCount = 0;
  
  function spawnWorker() {
    const { spawn } = require('child_process');
    const worker = spawn('node', ['batch/worker-v2.js', ...args], {
      stdio: 'inherit',
      env: { ...process.env, V2_CHUNK_LIMIT: req.query.chunk || '2000' },
      detached: true,
    });
    worker.unref();
    
    worker.on('close', (code) => {
      // Exit code 2 = more work to do, restart
      // Exit code 0 = done
      if (code === 2 && restartCount < maxRestarts) {
        restartCount++;
        console.log(`V2 worker chunk complete, restarting (${restartCount}/${maxRestarts})...`);
        setTimeout(spawnWorker, 2000);
      } else if (restartCount >= maxRestarts) {
        console.log(`V2 worker hit max restarts (${maxRestarts})`);
      }
    });
    
    worker.on('error', (err) => console.error(`V2 batch spawn error: ${err.message}`));
  }
  
  spawnWorker();
  
  res.json({
    started: true,
    command: `node batch/worker-v2.js ${args.join(' ')}`,
    chunkLimit: req.query.chunk || '2000',
    maxRestarts,
    message: 'V2 inference started with auto-restart. Will process in chunks until complete.',
  });
});

// GET /api/v2/batch/run — run v2 inference with streaming output
app.get('/api/v2/batch/run', (req, res) => {
  const BATCH_KEY = process.env.BATCH_SECRET || 'ss_batch_2026';
  if (req.query.key !== BATCH_KEY) return res.status(403).json({ error: 'Invalid batch key' });
  
  const args = [];
  if (req.query.zip) args.push(req.query.zip);
  else args.push('--all');
  
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  
  const { spawn } = require('child_process');
  const worker = spawn('node', ['batch/worker-v2.js', ...args], {
    env: process.env,
  });
  
  worker.stdout.on('data', (d) => res.write(d));
  worker.stderr.on('data', (d) => res.write(d));
  worker.on('close', (code) => { res.write(`\nExit code: ${code}\n`); res.end(); });
  worker.on('error', (err) => { res.write(`\nWorker error: ${err.message}\n`); res.end(); });
  req.on('close', () => { worker.kill(); });
});

// GET /api/v2/briefing/:zip — read persisted inference results
app.get('/api/v2/briefing/:zip', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  
  const { zip } = req.params;
  const tier = req.query.tier;
  const limit = Math.min(parseInt(req.query.limit) || 1000, 2000);
  
  // Read from inference join with parcels
  let query = supabase
    .from('seller_state_inference')
    .select('*, parcels(*)')
    .eq('zip_code', zip)
    .order('briefing_rank', { ascending: false })
    .limit(limit);
  
  if (tier) query = query.eq('act_tier', tier);
  
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  
  // Get counts per tier
  const { data: allTiers } = await supabase
    .from('seller_state_inference')
    .select('act_tier')
    .eq('zip_code', zip);
  
  const tierCounts = {};
  for (const r of (allTiers || [])) {
    tierCounts[r.act_tier] = (tierCounts[r.act_tier] || 0) + 1;
  }
  
  // Get deep signals
  const { data: deepSignals } = await supabase
    .from('deep_signals')
    .select('*')
    .eq('zip_code', zip);
  
  // Get total parcel count for this ZIP
  const { count: totalParcels } = await supabase
    .from('parcels')
    .select('id', { count: 'exact', head: true })
    .eq('zip_code', zip);

  res.json({
    leads: data || [],
    tierCounts,
    deepSignals: deepSignals || [],
    totalScored: (allTiers || []).length,
    totalParcels: totalParcels || (allTiers || []).length,
    cached: true,
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
  
  // Run background labeler automatically
  if (supabase) {
    // First run 60 seconds after startup
    setTimeout(() => runBackgroundLabeler(), 60 * 1000);
    // Then every 24 hours
    setInterval(() => runBackgroundLabeler(), 24 * 60 * 60 * 1000);
    console.log('Background labeler: scheduled (daily)');
  }
  
  // Nightly batch cron — runs at 2am Mountain (8am UTC)
  //
  // GUARD: before spawning a worker, check batch_runs for any currently-
  // running or recently-started run in the last 8 hours. If one exists,
  // skip this cron fire. This prevents two concurrent full-sweep workers
  // from racing on Supabase writes (which would deadlock parcel_scores
  // upserts and double the SerpAPI spend) when an operator manually
  // triggered a sweep late at night before the 2am cron. Without this
  // guard, the cron blindly spawns worker.js --all regardless of whether
  // a previous run is still running or just completed.
  try {
    const cron = require('node-cron');
    cron.schedule('0 8 * * *', async () => {
      console.log('=== NIGHTLY BATCH CRON CHECKING ===');
      
      // Guard: skip only if there is evidence of a substantive run that
      // already covered the work this cron would do. Two cases count:
      //   1. A run that's actually progressing — status='running' AND has
      //      meaningful recent write activity in zip_briefings (last 10 min)
      //   2. A completed run in the last 8 hours that covered ≥50 ZIPs
      //      (i.e. at least half of a full sweep — small verification runs
      //      don't count)
      //
      // We deliberately do NOT treat every row in the window as a blocker.
      // Stale 'running' rows from crashed workers are common (the process
      // dies but the row stays) and small manual runs for verification
      // shouldn't prevent the nightly full sweep from happening.
      if (supabase) {
        try {
          const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
          const { data: recentRuns } = await supabase
            .from('batch_runs')
            .select('id, started_at, completed_at, status, zips_processed')
            .gte('started_at', eightHoursAgo)
            .order('started_at', { ascending: false });
          
          let blocker = null;
          
          // Case 1: a run actively progressing right now
          // Look for 'running' rows AND verify by checking zip_briefings
          // for any write in the last 10 minutes. If zip_briefings is
          // being actively updated, SOMETHING is running — don't double up.
          const runningRows = (recentRuns || []).filter(r => r.status === 'running');
          if (runningRows.length > 0) {
            const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const { data: recentBriefings } = await supabase
              .from('zip_briefings')
              .select('zip_code')
              .gte('computed_at', tenMinAgo)
              .limit(1);
            
            if (recentBriefings && recentBriefings.length > 0) {
              blocker = runningRows[0];
              blocker._reason = `running row ${blocker.id} — zip_briefings written in last 10 min (real in-flight sweep)`;
            }
            // If no recent briefings, the 'running' rows are crash zombies.
            // Ignore them and proceed.
          }
          
          // Case 2: a substantive completed run already happened
          if (!blocker) {
            const substantive = (recentRuns || []).find(r =>
              (r.status === 'completed' || r.status === 'completed_with_errors')
              && (r.zips_processed || 0) >= 50
            );
            if (substantive) {
              blocker = substantive;
              blocker._reason = `completed run ${substantive.id} covered ${substantive.zips_processed} ZIPs`;
            }
          }
          
          if (blocker) {
            console.log(`=== NIGHTLY BATCH CRON SKIPPED ===`);
            console.log(`Reason: ${blocker._reason}`);
            console.log(`Blocker: id=${blocker.id} started=${blocker.started_at} status=${blocker.status} zips=${blocker.zips_processed || 0}`);
            console.log(`Cron will fire again tomorrow at 2am MT.`);
            return;
          }
          
          console.log(`Cron guard: no substantive recent run found — proceeding with batch`);
          if (runningRows.length > 0) {
            console.log(`(${runningRows.length} stale 'running' rows in window, ignored as crash zombies)`);
          }
        } catch (guardErr) {
          console.error(`Cron guard check failed: ${guardErr.message}. Proceeding with batch anyway.`);
        }
      }
      
      console.log('=== NIGHTLY BATCH CRON STARTING ===');
      const { spawn } = require('child_process');
      const worker = spawn('node', ['batch/worker.js', '--all'], {
        stdio: 'inherit',  // pipe output to server logs
        env: process.env,   // pass all env vars
      });
      worker.on('exit', (code) => {
        console.log(`=== NIGHTLY BATCH CRON FINISHED (exit code: ${code}) ===`);
      });
      worker.on('error', (err) => {
        console.error(`Batch cron error: ${err.message}`);
      });
    }, { timezone: 'America/Denver' });
    console.log('Batch cron: scheduled (2am Mountain / 8am UTC daily) with 8-hour recent-run guard');
  } catch(cronErr) {
    console.log('Batch cron: not configured (' + cronErr.message + ')');
  }
});

async function runBackgroundLabeler() {
  try {
    console.log('Background labeler: starting automatic check...');
    
    const { data: snapshots, error } = await supabase
      .from('parcel_snapshot')
      .select('parcel_id, snapshot_date, source_key, owner_name_raw, zip_code, tier, seller_likelihood, owner_type, tenure_years, is_absentee, is_out_of_state, latitude, longitude')
      .lte('snapshot_date', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
      .order('snapshot_date', { ascending: true })
      .limit(100);
    
    if (error || !snapshots || snapshots.length === 0) {
      console.log('Background labeler: no snapshots old enough to check');
      return;
    }
    
    // Filter to unchecked or stale (>7 days since last check)
    const parcelIds = snapshots.map(s => s.parcel_id);
    const { data: existingLabels } = await supabase
      .from('transfer_outcome_label')
      .select('parcel_id, snapshot_date, last_checked')
      .in('parcel_id', parcelIds);
    
    const labelMap = {};
    for (const l of (existingLabels || [])) {
      labelMap[`${l.parcel_id}_${l.snapshot_date}`] = l;
    }
    
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const toCheck = snapshots.filter(s => {
      const existing = labelMap[`${s.parcel_id}_${s.snapshot_date}`];
      if (!existing || !existing.last_checked) return true;
      return new Date(existing.last_checked).getTime() < weekAgo;
    });
    
    if (toCheck.length === 0) {
      console.log('Background labeler: all snapshots recently checked');
      return;
    }
    
    let transfers = 0, checked = 0, failed = 0;
    
    for (let i = 0; i < toCheck.length; i += 5) {
      const batch = toCheck.slice(i, i + 5);
      
      const results = await Promise.allSettled(batch.map(async (snap) => {
        // Use stored lat/lng — don't try to parse from parcel_id
        const lat = snap.latitude || null;
        const lng = snap.longitude || null;
        
        // Fallback: try parsing from parcel_id for legacy snapshots without lat/lng
        if (!lat || !lng) {
          const parts = snap.parcel_id.split('-');
          if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            const fallbackLat = parseFloat(parts[0]);
            const fallbackLng = parseFloat(parts[1]);
            if (fallbackLat > 20 && fallbackLat < 50 && fallbackLng < -60 && fallbackLng > -130) {
              return { snap, currentOwner: await queryCurrentOwner(snap.source_key, fallbackLat, fallbackLng) };
            }
          }
          return { snap, currentOwner: null };
        }
        
        if (!snap.source_key) return { snap, currentOwner: null };
        const currentOwner = await queryCurrentOwner(snap.source_key, lat, lng);
        return { snap, currentOwner };
      }));
      
      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value.currentOwner) { failed++; continue; }
        checked++;
        const { snap, currentOwner } = r.value;
        const snapOwner = normalizeOwnerForComparison(snap.owner_name_raw);
        const currOwner = normalizeOwnerForComparison(currentOwner);
        const ownerChanged = snapOwner && currOwner && snapOwner !== currOwner;
        if (ownerChanged) transfers++;
        
        const monthsSince = Math.floor((Date.now() - new Date(snap.snapshot_date).getTime()) / (30 * 24 * 60 * 60 * 1000));
        const labelUpdate = {
          parcel_id: snap.parcel_id, snapshot_date: snap.snapshot_date, zip_code: snap.zip_code,
          last_checked: new Date().toISOString(), check_source: 'gis_owner_compare',
          original_seller_likelihood: snap.seller_likelihood, original_tier: snap.tier,
          original_owner_type: snap.owner_type, original_tenure_years: snap.tenure_years,
          original_is_absentee: snap.is_absentee, original_is_out_of_state: snap.is_out_of_state
        };
        if (ownerChanged) {
          labelUpdate.sold_within_6m = monthsSince <= 6; 
          labelUpdate.sold_within_12m = monthsSince <= 12; 
          labelUpdate.sold_within_24m = true;
        } else {
          if (monthsSince >= 6) labelUpdate.sold_within_6m = false;
          if (monthsSince >= 12) labelUpdate.sold_within_12m = false;
          if (monthsSince >= 24) labelUpdate.sold_within_24m = false;
        }
        await supabase.from('transfer_outcome_label').upsert(labelUpdate, { onConflict: 'parcel_id,snapshot_date' });
      }
      
      if (i + 5 < toCheck.length) await new Promise(r => setTimeout(r, 500));
    }
    
    console.log(`Background labeler: ${checked} checked, ${transfers} transfers detected, ${failed} failed`);
  } catch(e) {
    console.error('Background labeler error:', e.message);
  }
}

// GET /api/v2/investigate-test — test investigation on a single address
app.get('/api/v2/investigate-test', async (req, res) => {
  const { address, city, state, owner } = req.query;
  if (!address) return res.status(400).json({ error: 'address required' });
  
  const { investigateParcel } = require('./batch/investigate');
  const result = await investigateParcel({
    id: 'test',
    owner_name: owner || 'UNKNOWN',
    address: address,
    city: city || 'Bozeman',
    state: state || 'MT',
  });
  
  res.json(result);
});

// GET /api/v2/batch/debug — run worker inline for debugging
app.get('/api/v2/batch/debug', async (req, res) => {
  const BATCH_KEY = process.env.BATCH_SECRET || 'ss_batch_2026';
  if (req.query.key !== BATCH_KEY) return res.status(403).json({ error: 'Invalid batch key' });
  const zip = req.query.zip;
  if (!zip) return res.status(400).json({ error: 'zip required' });
  
  try {
    // Just check how many need inference
    const { data: parcels } = await supabase.from('parcels').select('id').eq('zip_code', zip);
    const { data: existing } = await supabase.from('seller_state_inference').select('parcel_id, truth_hash').eq('zip_code', zip);
    
    res.json({
      totalParcels: parcels?.length || 0,
      existingInference: existing?.length || 0,
      needsWork: (parcels?.length || 0) - (existing?.length || 0),
    });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// GET /api/v2/backtest/:zip — compare v2 scores against recent sales (zero API calls)
app.get('/api/v2/backtest/:zip', async (req, res) => {
  const { zip } = req.params;
  
  // Get all v2 scores for this ZIP
  const { data: inferences } = await supabase
    .from('seller_state_inference')
    .select('parcel_id, seller_intent_score, briefing_rank, act_tier, ownership_archetype')
    .eq('zip_code', zip);
  
  if (!inferences || inferences.length < 50) return res.json({ error: 'Not enough data', count: inferences?.length || 0 });
  
  // Get parcels with transfer history
  const { data: parcels } = await supabase
    .from('parcels')
    .select('id, last_transfer_date, sale_price, tenure_years, is_absentee, is_out_of_state, owner_name, prop_type')
    .eq('zip_code', zip);
  
  const parcelMap = new Map((parcels || []).map(p => [p.id, p]));
  const scoreMap = new Map(inferences.map(i => [i.parcel_id, i]));
  
  const now = Date.now();
  const MS_24MO = 2 * 365.25 * 24 * 60 * 60 * 1000;
  
  let sold24 = 0, totalScored = inferences.length;
  let soldScores = [], unsoldScores = [];
  let recallCounts = { 25: 0, 35: 0, 45: 0, 55: 0 };
  let featureSold = { absentee: 0, outOfState: 0, trust: 0, llc: 0, vacantLand: 0, individual: 0 };
  let featureTotal = { absentee: 0, outOfState: 0, trust: 0, llc: 0, vacantLand: 0, individual: 0 };
  
  for (const inf of inferences) {
    const p = parcelMap.get(inf.parcel_id);
    if (!p) continue;
    
    const score = Math.round((inf.seller_intent_score || 0) * 100);
    const sold = p.last_transfer_date && (now - new Date(p.last_transfer_date).getTime()) < MS_24MO;
    
    // Feature counts
    if (p.is_absentee) { featureTotal.absentee++; if (sold) featureSold.absentee++; }
    if (p.is_out_of_state) { featureTotal.outOfState++; if (sold) featureSold.outOfState++; }
    const arch = inf.ownership_archetype || '';
    if (/trust/.test(arch)) { featureTotal.trust++; if (sold) featureSold.trust++; }
    if (/portfolio|llc/.test(arch)) { featureTotal.llc++; if (sold) featureSold.llc++; }
    if (/vacant/.test(arch)) { featureTotal.vacantLand++; if (sold) featureSold.vacantLand++; }
    if (/owner_occupant|individual/.test(arch)) { featureTotal.individual++; if (sold) featureSold.individual++; }
    
    if (sold) {
      sold24++;
      soldScores.push(score);
      for (const t of [25, 35, 45, 55]) { if (score >= t) recallCounts[t]++; }
    } else {
      unsoldScores.push(score);
    }
  }
  
  if (sold24 === 0) return res.json({ error: 'No recent sales found', totalScored });
  
  const avgScoreSold = Math.round(soldScores.reduce((a, b) => a + b, 0) / soldScores.length);
  const avgScoreNotSold = Math.round(unsoldScores.reduce((a, b) => a + b, 0) / (unsoldScores.length || 1));
  const scoreGap = avgScoreSold - avgScoreNotSold;
  const baseRate = sold24 / totalScored;
  
  const recall = {};
  for (const t of [25, 35, 45, 55]) { recall[t] = Math.round((recallCounts[t] / sold24) * 100); }
  
  const rates = {};
  const lifts = {};
  const featureNames = { absentee: 'Absentee', outOfState: 'Out-of-State', trust: 'Trust/Estate', llc: 'LLC/Portfolio', vacantLand: 'Vacant Land', individual: 'Individual Owner' };
  rates['All Properties'] = baseRate;
  for (const [key, label] of Object.entries(featureNames)) {
    if (featureTotal[key] > 10) {
      const rate = featureSold[key] / featureTotal[key];
      rates[label] = rate;
      lifts[label] = baseRate > 0 ? rate / baseRate : 0;
    }
  }
  
  res.json({
    version: 2,
    sold24,
    total: totalScored,
    baseRate,
    avgScoreSold,
    avgScoreNotSold,
    scoreGap,
    recall,
    rates,
    lifts,
    wouldHaveFlagged: recall[35] || 0,
  });
});
// Mon Apr  6 02:50:40 UTC 2026
