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

// Stripe webhook needs raw body
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

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

    // Parse location from address for geo-anchoring
    const addressParts = propertyAddress.split(',').map(p => p.trim());
    const city = addressParts[1] || '';
    const stateZip = addressParts[2] || '';
    const state = stateZip.split(' ')[0] || '';
    const locationContext = `${city}, ${state}`.trim();

    const systemPrompt = `You are a real estate research assistant. Given a name and address, find verified information about this specific person at this specific property.

STRICT RULES - FOLLOW EXACTLY:

1. ONLY search for: "${ownerName}" combined with "${propertyAddress}" or "${locationContext}"
   - Every search MUST include location terms
   - If a result doesn't mention ${city} or ${state}, IGNORE IT

2. DO NOT GUESS OR INFER:
   - If you don't find a spouse name explicitly stated, put "Unknown"
   - If you don't find their job explicitly stated, put "Unknown"  
   - If you find multiple people with same name, only use the one at THIS address
   - NEVER combine information from different people

3. WHAT TO SEARCH:
   - "${ownerName}" "${propertyAddress}"
   - "${ownerName}" "${city}" "${state}"
   - "${propertyAddress}" Zillow OR Redfin (for property data only)

4. VERIFY EVERYTHING:
   - Only include information you found directly linked to this person AND this location
   - If you're not 100% sure it's the same person, mark as "Unknown"

Return ONLY valid JSON (no markdown, no code blocks) with this structure:
{
    "name": "Full name",
    "address": "${propertyAddress}",
    "score": 0-100,
    "scoreLabel": "High Likelihood" or "Medium Likelihood" or "Low Likelihood",
    "metrics": {
        "estimatedValue": "$XXX,XXX from Zillow/Redfin or Unknown",
        "estimatedEquity": "$XXX,XXX or Unknown",
        "ownedSince": "YYYY or Unknown",
        "ageRange": "XX-XX or Unknown"
    },
    "whoTheyAre": {
        "spouse": "Name if explicitly found, otherwise Unknown",
        "occupation": "Job title if explicitly found, otherwise Unknown",
        "ownership": "Ownership type or Unknown",
        "decisionStyle": "Based on verified info or Unknown"
    },
    "howTheyThink": {
        "financialMindset": "Based on verified info or Unknown",
        "communication": "Based on verified info or Unknown",
        "socialPosition": "Based on verified info or Unknown",
        "bestChannel": "Letter/Phone/Email/Door"
    },
    "signals": ["Only verified facts - e.g. 'Owned since 2015 per county records'"],
    "approach": {
        "opening": "Opening based only on verified facts",
        "keyMessages": "Messages based only on verified facts",
        "avoid": "What to avoid",
        "timeline": "Timing recommendation"
    },
    "scripts": {
        "letter": "Letter using ONLY verified details. Include [AGENT_NAME] and [AGENT_PHONE].",
        "phone": "Phone script using ONLY verified details.",
        "door": "Door script using ONLY verified details.",
        "email": "Subject line first, then body. ONLY verified details."
    }
}

CRITICAL: "Unknown" is ALWAYS better than wrong information. Do not invent, infer, or guess.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8096,
      temperature: 0,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search'
      }],
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Find information about this property owner. Only report facts you can verify are about THIS specific person at THIS address.

NAME: ${ownerName}
ADDRESS: ${propertyAddress}

Search for "${ownerName}" + "${locationContext}" and "${propertyAddress}" on Zillow/Redfin. If you cannot verify something, say "Unknown". Do not guess.`
      }]
    });

    // Extract text content
    let textContent = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      }
    }

    // Parse JSON - handle potential markdown code blocks
    let jsonString = textContent;
    
    // Remove markdown code blocks if present
    jsonString = jsonString.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    
    const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse response');
    }

    const result = JSON.parse(jsonMatch[0]);

    // Save to cache
    await saveToCache(ownerName, propertyAddress, result);

    // Save to history if user is logged in
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
    res.status(500).json({ error: error.message || 'Research failed' });
  }
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
    // Create or get Stripe customer
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
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  const planLimits = {
    'price_pro': { plan: 'pro', signals_limit: 50 },
    'price_enterprise': { plan: 'enterprise', signals_limit: 999999 }
  };
  
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const customerId = session.customer;
      
      if (userId) {
        // Get subscription details
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const priceId = subscription.items.data[0]?.price.id;
        const planConfig = planLimits[priceId] || { plan: 'pro', signals_limit: 50 };
        
        await supabase
          .from('profiles')
          .update({
            stripe_customer_id: customerId,
            stripe_subscription_id: session.subscription,
            subscription_status: 'active',
            plan: planConfig.plan,
            signals_limit: planConfig.signals_limit,
            signals_used: 0
          })
          .eq('id', userId);
        
        console.log(`Upgraded user ${userId} to ${planConfig.plan}`);
      }
      break;
    }
    
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const status = subscription.status;
      
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('stripe_subscription_id', subscription.id)
        .single();
      
      if (profile) {
        const updates = { subscription_status: status };
        
        if (status === 'canceled' || status === 'unpaid') {
          updates.plan = 'free';
          updates.signals_limit = 3;
        }
        
        await supabase
          .from('profiles')
          .update(updates)
          .eq('id', profile.id);
        
        console.log(`Updated subscription status for user ${profile.id}: ${status}`);
      }
      break;
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

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: './public' });
});

app.listen(PORT, () => {
  console.log(`SellerSignal running on port ${PORT}`);
  console.log(`Supabase: ${supabase ? 'connected' : 'not configured'}`);
  console.log(`Stripe: ${stripe ? 'connected' : 'not configured'}`);
});
