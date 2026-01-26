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

async function gatherSearchResults(ownerName, streetAddress, city, state) {
  console.log('Running comprehensive searches...');
  
  const nameParts = ownerName.trim().split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts[nameParts.length - 1] || '';
  
  const searches = [
    { label: 'Zillow Property', query: `"${streetAddress}" "${city}" site:zillow.com` },
    { label: 'Redfin Property', query: `"${streetAddress}" "${city}" site:redfin.com` },
    { label: 'Realtor Property', query: `"${streetAddress}" "${city}" site:realtor.com` },
    { label: 'Trulia Property', query: `"${streetAddress}" "${city}" site:trulia.com` },
    { label: 'County Tax Records', query: `"${streetAddress}" "${city}" ${state} tax assessor property` },
    { label: 'County Property Records', query: `"${streetAddress}" ${city} ${state} county property records deed` },
    { label: 'Owner at Address', query: `"${ownerName}" "${streetAddress}"` },
    { label: 'Owner Address City', query: `"${ownerName}" "${streetAddress}" "${city}"` },
    { label: 'Owner City State', query: `"${ownerName}" "${city}" ${state}` },
    { label: 'Owner State', query: `"${ownerName}" ${state}` },
    { label: 'LinkedIn', query: `"${ownerName}" ${city} ${state} site:linkedin.com` },
    { label: 'LinkedIn Alt', query: `"${firstName} ${lastName}" ${state} site:linkedin.com` },
    { label: 'Business Owner', query: `"${ownerName}" "${city}" business owner` },
    { label: 'Company', query: `"${ownerName}" "${city}" ${state} company OR LLC OR inc` },
    { label: 'Professional', query: `"${ownerName}" "${city}" ${state} professional OR career OR work` },
    { label: 'FastPeopleSearch', query: `"${ownerName}" "${city}" site:fastpeoplesearch.com` },
    { label: 'WhitePages', query: `"${ownerName}" "${city}" ${state} site:whitepages.com` },
    { label: 'Spokeo', query: `"${ownerName}" "${city}" site:spokeo.com` },
    { label: 'Facebook', query: `"${ownerName}" "${city}" ${state} site:facebook.com` },
    { label: 'News Mentions', query: `"${ownerName}" "${city}" ${state} news OR article` },
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

PROPERTY ANALYSIS:
- Look for Zillow/Redfin data: price, beds, baths, sqft, year built, sale history
- Look for ownership records: purchase date, price paid
- For Montana properties, Zillow estimates may be 20-30% below market

OWNER ANALYSIS:
- Look for LinkedIn profile: job title, employer, location
- Look for news articles or business listings
- Look for any public records mentioning the owner

SELLER LIKELIHOOD SCORING (0-100):
Start at 35 (baseline). Adjust based on findings:
- Young family indicators: -20
- Recent purchase (last 2-3 years): -15  
- Renovations/improvements: -15
- Long ownership (15+ years): +10
- Age 60+: +15
- Empty nester indicators: +10
- Out of state owner: +15

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
    "signals": [
        {"text": "Signal description", "type": "positive"},
        {"text": "Signal description", "type": "negative"},
        {"text": "Signal description", "type": "neutral"}
    ],
    "approach": {
        "opening": "Recommended approach",
        "keyMessages": "Key points",
        "avoid": "What to avoid",
        "timeline": "Suggested timeline"
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
