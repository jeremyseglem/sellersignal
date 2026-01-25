require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize clients
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Middleware
app.use(cors());
app.use(express.static('public'));
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ===================
// CACHING (Supabase)
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
  
  if (data) {
    console.log(`Cache hit: ${ownerName}`);
    return data.result;
  }
  return null;
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
  
  console.log(`Cached: ${ownerName}`);
}

// Helper function to wait
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to call Anthropic with retry logic
async function callAnthropicWithRetry(prompt, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        temperature: 0,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: prompt }]
      });
      return response;
    } catch (error) {
      if (error.status === 429 || (error.message && error.message.includes('rate'))) {
        const waitTime = attempt * 5000;
        console.log(`Rate limited. Attempt ${attempt}/${maxRetries}. Waiting ${waitTime/1000}s...`);
        if (attempt < maxRetries) {
          await sleep(waitTime);
          continue;
        }
      }
      throw error;
    }
  }
}

// ===================
// RESEARCH ENDPOINT
// ===================
app.post('/api/research', async (req, res) => {
  try {
    const { ownerName, propertyAddress, userId } = req.body;

    if (!ownerName || !propertyAddress) {
      return res.status(400).json({ error: 'Owner name and property address required' });
    }

    // Check cache first
    const cached = await getFromCache(ownerName, propertyAddress);
    if (cached) {
      return res.json(cached);
    }

    console.log(`Researching: ${ownerName} at ${propertyAddress}`);

    // Parse address components
    const addressParts = propertyAddress.split(',').map(p => p.trim());
    const streetAddress = addressParts[0] || '';
    const city = addressParts[1] || '';
    const state = addressParts[2] || '';

    // ============================================
    // PROPRIETARY RESEARCH PROMPT
    // ============================================
    const researchPrompt = `You are SellerSignal, an elite real estate intelligence system that builds comprehensive psychological profiles of property owners.

PROSPECT: ${ownerName}
PROPERTY: ${propertyAddress}

CRITICAL INSTRUCTION: The user has confirmed ${ownerName} owns ${propertyAddress}. This is fact. Your job is deep intelligence gathering about THIS SPECIFIC PERSON at THIS SPECIFIC ADDRESS.

=== SEARCH STRATEGY (Follow this exactly) ===

SEARCH 1: "${streetAddress}" "${city}" site:zillow.com OR site:redfin.com OR site:realtor.com
- Extract: Current value estimate, beds/baths, sq ft, year built, sale history

SEARCH 2: "${ownerName}" "${city}" "${state}"
- Extract: Current employer, job title, LinkedIn profile info, professional background
- ONLY use results that reference this specific location

SEARCH 3: "${ownerName}" spouse OR wife OR husband "${city}" "${state}"
- Extract: Spouse name, spouse occupation
- Look for: wedding announcements, news articles mentioning both names, obituaries listing family

SEARCH 4: "${ownerName}" "${city}" news OR article
- Extract: Community involvement, business news, any public mentions

=== CRITICAL ACCURACY RULES ===

1. LOCATION LOCK: ONLY use information about a "${ownerName}" who is connected to ${city}, ${state}. If you find someone with the same name in a different city/state, IGNORE THEM COMPLETELY.

2. NO GUESSING: If you cannot verify something with a source that mentions BOTH the name AND the location, mark it as "Unknown"

3. NO COMBINING: Do not combine information from different people who happen to share the same name

4. VERIFY CONNECTIONS: Before listing a spouse, employer, or any fact, confirm it's about the person in ${city}, ${state}

=== OUTPUT FORMAT ===

Return ONLY valid JSON (no markdown, no code blocks):

{
  "name": "${ownerName}",
  "address": "${propertyAddress}",
  "propertyIntel": {
    "estimatedValue": "$XXX,XXX (source: Zillow/Redfin)",
    "lastSaleDate": "Date or Unknown",
    "lastSalePrice": "$XXX,XXX or Unknown",
    "equityEstimate": "Estimated equity or Unknown",
    "bedsBaths": "X bed / X bath or Unknown",
    "squareFeet": "X,XXX sq ft or Unknown",
    "yearBuilt": "Year or Unknown"
  },
  "ownerProfile": {
    "occupation": "Job title at Company - ONLY if verified in ${city}/${state}, otherwise Unknown",
    "employer": "Company name - ONLY if verified in ${city}/${state}, otherwise Unknown",
    "estimatedAge": "Age range or Unknown",
    "background": "2-3 sentence summary of VERIFIED information only"
  },
  "familyConnections": {
    "spouse": {
      "name": "Spouse name ONLY if explicitly found connected to this person in ${city}/${state}, otherwise Unknown",
      "occupation": "Spouse job or Unknown",
      "source": "Where you found this information"
    },
    "keyInfluencers": "Who likely influences their decisions, or Unknown"
  },
  "psychologicalProfile": {
    "financialMindset": "Based on verified info, or Unknown",
    "decisionStyle": "Based on verified info, or Unknown",
    "communicationPreference": "Based on verified info, or Unknown"
  },
  "motivationSignals": [
    {"signal": "Specific verified signal", "type": "positive|neutral|negative", "weight": "high|medium|low", "source": "Where you found this"}
  ],
  "score": 50,
  "scoreLabel": "High Likelihood|Medium Likelihood|Low Likelihood",
  "scoreSummary": "2-3 sentences explaining score with VERIFIED evidence only",
  "approach": {
    "bestChannel": "door|phone|mail|email",
    "keyTalkingPoints": ["Point based on verified facts only"],
    "avoidTopics": ["What not to bring up"]
  },
  "scripts": {
    "doorknock": "Script using ONLY verified details. Reference specific facts you confirmed.",
    "phone": "Script using ONLY verified details.",
    "letter": "3 paragraph letter using ONLY verified details. Include [AGENT_NAME] and [AGENT_PHONE] placeholders.",
    "email": "Subject: [Line]\\n\\nEmail body using ONLY verified details."
  },
  "researchNotes": "Sources used, confidence level, what could NOT be verified"
}

=== SCORING GUIDELINES ===

Start at 45, then adjust:

PROPERTY: Owned 10+ years: +15 | Owned 5-10 years: +10 | Owned < 3 years: -15 | High equity: +10
OWNER: Age 60+: +10 | Approaching retirement: +15 | Recent job change: +10
FAMILY: Empty nesters: +10 | Strong local ties: -10

REMEMBER: "Unknown" is ALWAYS better than wrong. Only report what you can verify is about THIS person at THIS address.`;

    // Call API with retry
    const response = await callAnthropicWithRetry(researchPrompt);

    // Extract text
    let fullText = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        fullText += block.text;
      }
    }

    if (!fullText.trim()) {
      return res.status(500).json({ error: 'No results returned. Please try again.' });
    }

    // Parse JSON
    const result = parseJSON(fullText);
    if (!result) {
      return res.status(500).json({ error: 'Failed to parse results. Please try again.' });
    }

    // Save to cache
    await saveToCache(ownerName, propertyAddress, result);

    // Save to history if logged in
    if (userId && supabase) {
      await supabase.from('signals_history').insert({
        user_id: userId,
        owner_name: ownerName,
        property_address: propertyAddress,
        score: result.score
      });
    }

    res.json(result);

  } catch (error) {
    console.error('Research error:', error);
    if (error.status === 429) {
      return res.status(429).json({ error: 'High demand. Please wait 30 seconds and try again.' });
    }
    res.status(500).json({ error: 'Research failed. Please try again.' });
  }
});

// Robust JSON parser
function parseJSON(text) {
  let jsonStr = text;

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1];
  } else {
    const matches = text.match(/\{[\s\S]*\}/g);
    if (matches && matches.length > 0) {
      jsonStr = matches.reduce((a, b) => a.length > b.length ? a : b);
    }
  }

  jsonStr = jsonStr
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('JSON parse error:', e.message);
    return null;
  }
}

// ===================
// CACHE MANAGEMENT
// ===================
app.post('/api/cache/clear', async (req, res) => {
  if (supabase) {
    await supabase.from('signals_cache').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  }
  res.json({ status: 'Cache cleared' });
});

// ===================
// USER PROFILE
// ===================
app.get('/api/profile/:userId', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });
  
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', req.params.userId)
    .single();
  
  if (error) return res.status(404).json({ error: 'Profile not found' });
  res.json(data);
});

app.post('/api/profile/:userId/increment', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });
  
  const { data: profile } = await supabase
    .from('profiles')
    .select('signals_used')
    .eq('id', req.params.userId)
    .single();
  
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  
  const { data, error } = await supabase
    .from('profiles')
    .update({ signals_used: (profile.signals_used || 0) + 1 })
    .eq('id', req.params.userId)
    .select()
    .single();
  
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ===================
// STRIPE CHECKOUT
// ===================
app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  
  const { priceId, userId, email } = req.body;
  
  try {
    let customerId;
    
    if (supabase && userId) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', userId)
        .single();
      
      if (profile?.stripe_customer_id) {
        customerId = profile.stripe_customer_id;
      }
    }
    
    if (!customerId) {
      const customer = await stripe.customers.create({ email });
      customerId = customer.id;
      
      if (supabase && userId) {
        await supabase
          .from('profiles')
          .update({ stripe_customer_id: customerId })
          .eq('id', userId);
      }
    }
    
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.APP_URL || 'http://localhost:3001'}/?success=true`,
      cancel_url: `${process.env.APP_URL || 'http://localhost:3001'}/?canceled=true`,
      metadata: { userId }
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
  if (!stripe || !supabase) return res.status(500).send('Not configured');
  
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  const planLimits = {
    'price_pro': { plan: 'pro', signals_limit: 50 },
    'price_enterprise': { plan: 'enterprise', signals_limit: 999999 }
  };
  
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    
    if (userId) {
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const priceId = subscription.items.data[0]?.price.id;
      const planConfig = planLimits[priceId] || { plan: 'pro', signals_limit: 50 };
      
      await supabase
        .from('profiles')
        .update({
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          subscription_status: 'active',
          plan: planConfig.plan,
          signals_limit: planConfig.signals_limit,
          signals_used: 0
        })
        .eq('id', userId);
    }
  }
  
  res.json({ received: true });
});

// ===================
// HEALTH CHECK
// ===================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    supabase: !!supabase,
    stripe: !!stripe,
    anthropic: !!process.env.ANTHROPIC_API_KEY
  });
});

app.get('/', (req, res) => {
  res.sendFile('index.html', { root: './public' });
});

app.listen(PORT, () => {
  console.log(`SellerSignal running on port ${PORT}`);
  console.log(`Supabase: ${supabase ? 'connected' : 'not configured'}`);
  console.log(`Stripe: ${stripe ? 'connected' : 'not configured'}`);
});
