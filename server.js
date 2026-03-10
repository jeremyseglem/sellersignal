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
  
  // Don't normalize entity names
  if (/LLC|TRUST|LTD|PARTNERSHIP|INC|CORP|ESTATE|FOUNDATION|COMPANY/i.test(rawName)) {
    return rawName.trim();
  }
  
  // Handle "LASTNAME FIRSTNAME MIDDLE" format (most common in parcel data)
  let name = rawName.trim();
  
  // Remove suffixes like "& JAMIE A" for couples — keep primary owner
  name = name.replace(/\s*&\s*.*$/, '').trim();
  
  // Convert to title case first
  name = name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  
  // If ALL CAPS was the input and it looks like LAST FIRST MIDDLE format
  const parts = name.split(/\s+/);
  
  if (parts.length >= 2) {
    // Check if it looks like "Seglem Jeremy Maxwell" (last first middle)
    // Heuristic: in parcel data, last name is first
    // We rearrange to "Jeremy Maxwell Seglem" → but for searching "Jeremy Seglem" is best
    const lastName = parts[0];
    const firstName = parts[1];
    const middle = parts.slice(2).join(' ');
    
    // Return both formats for different search strategies
    return {
      full: middle ? `${firstName} ${middle} ${lastName}` : `${firstName} ${lastName}`,
      searchPrimary: `${firstName} ${lastName}`,
      first: firstName,
      last: lastName,
      original: rawName.trim()
    };
  }
  
  return {
    full: name,
    searchPrimary: name,
    first: parts[0] || '',
    last: parts[parts.length - 1] || '',
    original: rawName.trim()
  };
}

// Throttled batch search implementation
async function searchBatch(queries) {
  const output = {};
  const batchSize = 8;
  
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
    
    // Pause between batches to avoid throttling
    if (i + batchSize < queries.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  return output;
}

// ===================
// LAYERED RESEARCH v3 — All 40 searches in parallel
// ===================
async function gatherSearchResultsV2(ownerName, streetAddress, city, state) {
  console.log('Deep Signal v3: 40 parallel searches...');
  
  // Normalize parcel-format name (e.g. "SEGLEM JEREMY MAXWELL" → "Jeremy Seglem")
  const normalized = normalizeOwnerName(ownerName);
  const searchName = typeof normalized === 'object' ? normalized.searchPrimary : ownerName;
  const fullName = typeof normalized === 'object' ? normalized.full : ownerName;
  const firstName = typeof normalized === 'object' ? normalized.first : (ownerName.trim().split(' ')[0] || '');
  const lastName = typeof normalized === 'object' ? normalized.last : (ownerName.trim().split(' ').pop() || '');
  
  console.log(`  Raw: "${ownerName}" → Search: "${searchName}" | Full: "${fullName}" | First: "${firstName}" Last: "${lastName}"`);
  const startTime = Date.now();

  const allSearches = [
    // PROPERTY (6)
    { label: 'Zillow', query: `"${streetAddress}" "${city}" site:zillow.com` },
    { label: 'Redfin', query: `"${streetAddress}" "${city}" site:redfin.com` },
    { label: 'Realtor.com', query: `"${streetAddress}" "${city}" site:realtor.com` },
    { label: 'Trulia', query: `"${streetAddress}" "${city}" site:trulia.com` },
    { label: 'County Tax', query: `"${streetAddress}" "${city}" ${state} tax assessor property` },
    { label: 'Property History', query: `"${streetAddress}" "${city}" sold sale listing history` },
    
    // OWNER + ADDRESS CONNECTION (4)
    { label: 'Owner at Address', query: `"${searchName}" "${streetAddress}"` },
    { label: 'Owner+Address+City', query: `"${searchName}" "${streetAddress}" "${city}"` },
    { label: 'Owner+City+State', query: `"${searchName}" "${city}" ${state}` },
    { label: 'Owner+State', query: `"${searchName}" ${state}` },
    
    // AGENT DETECTION (7)
    { label: 'Zillow Agent', query: `"${searchName}" ${city} ${state} site:zillow.com/profile` },
    { label: 'Realtor.com Agent', query: `"${searchName}" ${city} ${state} site:realtor.com/realestateagents` },
    { label: 'Redfin Agent', query: `"${searchName}" ${city} ${state} site:redfin.com/real-estate-agents` },
    { label: 'RE Agent General', query: `"${searchName}" "${city}" realtor OR "real estate agent" OR broker` },
    { label: 'Brokerage Bio', query: `"${searchName}" "${city}" ${state} brokerage OR "realty" bio OR team` },
    { label: 'Agent Reviews', query: `"${searchName}" "${city}" agent reviews OR testimonials OR sold` },
    { label: 'Agent Transactions', query: `"${searchName}" "${city}" ${state} listings OR transactions OR closed` },
    
    // PROFESSIONAL (4)
    { label: 'LinkedIn', query: `"${searchName}" ${city} ${state} site:linkedin.com` },
    { label: 'LinkedIn Alt', query: `"${firstName} ${lastName}" ${state} site:linkedin.com` },
    { label: 'Business Owner', query: `"${searchName}" "${city}" business owner` },
    { label: 'Company', query: `"${searchName}" "${city}" ${state} company OR LLC OR inc` },
    
    // PEOPLE SEARCH (3)
    { label: 'FastPeopleSearch', query: `"${searchName}" "${city}" site:fastpeoplesearch.com` },
    { label: 'WhitePages', query: `"${searchName}" "${city}" ${state} site:whitepages.com` },
    { label: 'Spokeo', query: `"${searchName}" "${city}" site:spokeo.com` },
    
    // SOCIAL + NEWS (3)
    { label: 'Facebook', query: `"${searchName}" "${city}" ${state} site:facebook.com` },
    { label: 'News', query: `"${searchName}" "${city}" ${state} news OR article` },
    { label: 'Professional Profile', query: `"${searchName}" "${city}" ${state} professional OR career OR work` },
    
    // FAMILY + RECORDS (3)
    { label: 'Family', query: `"${searchName}" "${city}" spouse OR wife OR husband OR family` },
    { label: 'Marriage', query: `"${searchName}" ${state} marriage OR wedding` },
    { label: 'Neighborhood', query: `"${streetAddress}" "${city}" neighborhood OR area` },
    
    // INTENT & LIFE SIGNALS — NEW (7)
    { label: 'Life Events', query: `"${searchName}" "${city}" ${state} retired OR retirement OR divorce OR obituary` },
    { label: 'Relocation', query: `"${searchName}" "moving" OR "relocated" OR "new home" OR "downsizing"` },
    { label: 'Community', query: `"${searchName}" "${city}" ${state} board OR volunteer OR foundation OR donation` },
    { label: 'Other Properties', query: `"${searchName}" ${state} property OR parcel OR deed -"${streetAddress}"` },
    { label: 'Court Records', query: `"${searchName}" "${city}" ${state} court OR filing OR lien OR judgment` },
    { label: 'Phone Email', query: `"${searchName}" "${city}" ${state} phone OR email OR contact` },
    { label: 'Age Records', query: `"${searchName}" "${city}" age OR born OR birthday` },
  ];

  // ENTITY RESOLUTION — add extra searches when owner is LLC/Trust/Corp
  const isEntity = /LLC|TRUST|LTD|PARTNERSHIP|INC|CORP|ESTATE|FOUNDATION|HOLDINGS|COMPANY|GROUP/i.test(ownerName);
  if (isEntity) {
    const entityName = ownerName.trim();
    const stateAbbr = state.trim().toUpperCase();
    
    const sosSearches = [
      { label: 'SOS Registered Agent', query: `"${entityName}" ${stateAbbr} registered agent secretary of state` },
      { label: 'SOS Business Filing', query: `"${entityName}" ${stateAbbr} business entity filing` },
      { label: 'SOS MT', query: `"${entityName}" site:sos.mt.gov` },
      { label: 'SOS WA', query: `"${entityName}" site:sos.wa.gov` },
      { label: 'Entity Members', query: `"${entityName}" ${stateAbbr} member OR manager OR officer OR principal` },
      { label: 'Entity OpenCorporates', query: `"${entityName}" ${stateAbbr} site:opencorporates.com` },
    ];
    
    allSearches.push(...sosSearches);
    console.log(`  Entity detected: "${entityName}" — added ${sosSearches.length} SOS searches (${allSearches.length} total)`);
  }

  // Fire all searches in throttled batches
  const results = await searchBatch(allSearches);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalResults = Object.values(results).reduce((sum, r) => sum + r.length, 0);
  const nonEmpty = Object.values(results).filter(r => r.length > 0).length;
  console.log(`  ${allSearches.length} searches complete in ${elapsed}s — ${nonEmpty} returned results (${totalResults} total items)`);

  // Organize into layers for formatting
  return {
    propertyResults: Object.fromEntries(Object.entries(results).filter(([k]) => 
      ['Zillow','Redfin','Realtor.com','Trulia','County Tax','Property History','Neighborhood'].includes(k))),
    ownerResults: Object.fromEntries(Object.entries(results).filter(([k]) => 
      ['Owner at Address','Owner+Address+City','Owner+City+State','Owner+State','LinkedIn','LinkedIn Alt','FastPeopleSearch','WhitePages','Spokeo','Business Owner','Company','Professional Profile','Phone Email','Age Records'].includes(k))),
    intentResults: Object.fromEntries(Object.entries(results).filter(([k]) => 
      ['Facebook','News','Family','Marriage','Life Events','Relocation','Community','Other Properties','Court Records'].includes(k))),
    connectionResults: Object.fromEntries(Object.entries(results).filter(([k]) => 
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
    const isEntity = /LLC|TRUST|LTD|PARTNERSHIP|INC|CORP|ESTATE|FOUNDATION|HOLDINGS|COMPANY|GROUP/i.test(resolvedOwner || ownerName);
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

    const systemPrompt = `You are SellerSignal's Deep Signal research engine. You produce actionable intelligence reports for real estate professionals who will use this information in real conversations with property owners.

YOUR GOAL: Produce the most useful, complete profile possible from the search results. An agent should be able to read this report and walk up to the owner's door feeling prepared.

CRITICAL LOCATION RULE: The property being evaluated is at "${propertyAddress}". ALL approach strategy, scripts, market references, and outreach must be oriented around THIS property location and THIS local market — NOT where the entity is incorporated or where the owner's mailing address is. If the owner is an LLC registered in Walla Walla but the property is in Bozeman, the scripts talk about the Bozeman market.

ENTITY + PRINCIPAL RESOLUTION: When the owner is an entity (LLC/Trust/Corp) and a principal or member has been identified in the search results, build the profile around THAT PERSON — their age, career, phone number, psychology. The entity information should still be reported but the actionable intelligence is about the human, not the LLC.

CONFIDENCE LEVELS:
- CONFIRMED: Directly stated in search results
- CORROBORATED: Found or strongly implied across multiple results  
- INFERRED: A reasonable professional conclusion from available evidence — label it but DO provide it
- NOT FOUND: Genuinely nothing in the results to support even an inference

CRITICAL: "Not found" is a last resort, not a default. If someone owns a $1.6M home in Bozeman, has been there 20 years, and appears to be 65+, you can infer plenty about their financial position, life stage, communication preferences, and likely motivations — even if LinkedIn didn't return a result. Real estate agents make these assessments every day based on exactly this type of data. Your job is to do it better and faster.

PROPERTY ANALYSIS — extract all available:
- Zillow/Redfin estimate, Zestimate, beds/baths/sqft/year built
- Last sale date and price (this is critical for equity calculation)
- Tax assessed value vs market estimate
- Any listing history, price changes, days on market
- Permits, renovations, or improvements
- Lot size, property type, HOA info

OWNER ANALYSIS — extract and infer:
- Full name, EXACT age or age range — people search sites almost always have this, look carefully in FastPeopleSearch, WhitePages, Spokeo snippets
- Spouse/partner name — often in people search results as "associated with" or "related to", also check deed records
- PHONE NUMBERS: FastPeopleSearch, WhitePages, and Spokeo results frequently contain phone numbers in their snippets or titles. Extract ALL phone numbers found. This is one of the most valuable outputs — do not skip it.
- EMAIL ADDRESSES: Extract any email addresses visible in search results
- Occupation, employer, career history — LinkedIn is primary, but also check news mentions and business records
- Other properties owned, business ownership, LLCs
- Community involvement, board memberships, charitable donations
- Social media profiles and activity level
- Whether they are a real estate agent (check ALL agent-specific search results — if they are an agent, note brokerage, production volume, specialties, team members, reviews)
- Relatives, associates, and household members from people search results
- Any court records, liens, judgments, or legal filings found

ENTITY RESOLUTION (for LLC/Trust/Corp owners):
When the property owner is an entity rather than an individual:
- Look for Secretary of State filings showing the registered agent, members, managers, or officers
- IMPORTANT: The registered agent is often an attorney or filing service, NOT the actual owner. Label them as "Registered Agent" not "Owner"
- If members or managers are listed, those are more likely the actual beneficial owners
- Report the entity name, registration date, status, registered agent name and address, and any identified members/principals
- Structure this as: Entity Name → Registered Agent (name, address, role) → Identified Members/Principals if found
- Do NOT replace the entity name with the registered agent name in the owner field — show both

PSYCHOLOGICAL PROFILE — this is what makes SellerSignal valuable:
Based on ALL available evidence (property data, career, age, neighborhood, ownership duration), build a profile:
- Financial mindset: Are they wealth-builders, preservers, or spenders? Base this on property value, career type, ownership patterns
- Communication style: Based on profession and generation. An engineer communicates differently than a teacher. A boomer responds differently than Gen X.
- Decision process: Based on property ownership patterns and career. Did they buy once and hold? Multiple moves? Investment properties?
- Life stage assessment: Based on age, ownership duration, family indicators. Be specific.
- Motivators: What would realistically make someone in their exact situation consider selling?
- Concerns: What would hold them back? Be specific to their situation.
- Pride points: What are they likely proud of? Home improvements, career, family, community standing?

APPROACH STRATEGY:
Based on the profile, provide specific, actionable guidance — not generic advice. If you know they're an engineer, say "lead with data and comparables." If they're a longtime community member, say "reference specific neighborhood changes they've witnessed."

SCRIPTS:
Write genuinely personalized scripts using every confirmed and inferred detail. Reference their name, their street, their likely situation. A script that could apply to any homeowner is worthless. If data is limited, write the best possible script with what you have and note which lines should be customized further.

SCORING: Start at ${preliminaryScore || 35} (from parcel data). Adjust based on findings:
- Confirmed/inferred long ownership (15+yr): +10
- Confirmed/inferred age 60+: +15
- Confirmed retirement or approaching retirement: +15
- Confirmed life transition (divorce, death, kids left): +15
- Out-of-state owner: +15
- Multiple property owner: +10
- Recent purchase (<3yr): -15
- Young family indicators: -20
- Recent renovation/investment in property: -10
- Property is their business/income source: -10

Return ONLY valid JSON with the same structure as before but FILL IN every field with the best available information or inference. "Not enough data" should only appear when there is genuinely nothing — not even property value, ownership duration, or neighborhood context — to base an assessment on.

JSON structure:
{
  "name": "Full name",
  "address": "Full address",
  "dataQuality": "Rich/Moderate/Limited",
  "score": 0-100,
  "scoreLabel": "High Likelihood/Medium Likelihood/Low Likelihood",
  "scoreBasis": "Explanation of what drove this score",
  "metrics": {
    "estimatedValue": "$XXX,XXX",
    "estimatedEquity": "$XXX,XXX",
    "ownedSince": "YYYY",
    "ageRange": "XX-XX"
  },
  "confirmedFacts": ["Each key fact found with source type noted"],
  "contactInfo": {
    "phones": ["All phone numbers found"],
    "emails": ["All email addresses found"],
    "relatives": ["Names of relatives/associates found"]
  },
  "entityInfo": {
    "entityName": "LLC/Trust/Corp name or null if individual",
    "registeredAgent": "Name and address of registered agent, or null",
    "registeredAgentRole": "Attorney/Filing Service/Individual",
    "members": ["Identified members, managers, or principals"],
    "filingDate": "Date entity was filed or null",
    "status": "Active/Inactive or null"
  },
  "whoTheyAre": {
    "spouse": "Name or Not found",
    "occupation": "Title at Company, or inferred profession/status",
    "ownership": "How title is held",
    "decisionStyle": "Assessment based on all available evidence"
  },
  "howTheyThink": {
    "financialMindset": "Assessment based on property, career, ownership patterns",
    "communication": "Assessment based on generation, profession, community",
    "socialPosition": "Assessment based on property, neighborhood, community involvement",
    "bestChannel": "Letter/Phone/Email/Door with specific reasoning"
  },
  "whatMakesThemTick": {
    "personalityType": "Assessment with reasoning",
    "decisionSpeed": "Assessment with reasoning",
    "lifeStage": "Specific assessment",
    "motivators": "Specific to their situation",
    "pridePoints": "Specific to what you found",
    "concerns": "Specific to their situation"
  },
  "wealthIndicators": {
    "incomeLevel": "Based on property + career evidence",
    "netWorthEstimate": "Range with reasoning",
    "evidence": ["List of wealth signals found or inferred"],
    "financialSophistication": "Low/Medium/High with reasoning"
  },
  "signals": [{"text": "Signal description", "type": "positive/negative/neutral", "confidence": "Confirmed/Inferred"}],
  "approach": {
    "opening": "Specific personalized opening strategy",
    "keyMessages": "Key points to hit based on their situation",
    "avoid": "Specific things to avoid based on their profile",
    "timing": "Specific timing recommendation"
  },
  "scripts": {
    "letter": "Full personalized letter with [AGENT_NAME] and [AGENT_PHONE] placeholders",
    "phone": "Full phone script",
    "door": "Full door knock script",
    "email": "Subject line then full email body"
  }
}`;


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

${formattedResults}

Generate the Deep Signal report. ONLY include information found in these results. All scripts and approach strategy must reference the ${city || 'local'} market, NOT any other location where the entity may be registered.`
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
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
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
