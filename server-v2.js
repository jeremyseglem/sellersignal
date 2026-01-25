require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3001;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

app.use(cors());
app.use(express.static('public'));
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

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
  if (data) return data.result;
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
}

app.post('/api/research', async (req, res) => {
  try {
    const { ownerName, propertyAddress, userId } = req.body;
    if (!ownerName || !propertyAddress) {
      return res.status(400).json({ error: 'Owner name and property address required' });
    }

    const cached = await getFromCache(ownerName, propertyAddress);
    if (cached) return res.json(cached);

    console.log(`Researching: ${ownerName} at ${propertyAddress}`);

    const systemPrompt = `You are a real estate research assistant. You MUST use the web_search tool to find REAL information. DO NOT GUESS OR MAKE UP ANY INFORMATION.

CRITICAL: Every piece of information you report MUST come from an actual web search result. If you cannot find something, say "Unknown".

Your job:
1. Search for the property address to find tax records, Zillow data, ownership info
2. Search for the owner's name to find their occupation, LinkedIn, business
3. Search for spouse/family information from property records or social media
4. Only report facts you actually found - never fabricate

Return JSON with this structure:
{
    "name": "Full name",
    "address": "Full address",
    "score": 0-100,
    "scoreLabel": "High Likelihood" or "Medium Likelihood" or "Low Likelihood",
    "metrics": {
        "estimatedValue": "$XXX,XXX",
        "estimatedEquity": "$XXX,XXX",
        "ownedSince": "YYYY",
        "ageRange": "XX-XX"
    },
    "whoTheyAre": {
        "spouse": "Name if found on title/records, else Unknown",
        "occupation": "From LinkedIn or business site, else Unknown",
        "ownership": "How title is held",
        "decisionStyle": "Based on profession"
    },
    "howTheyThink": {
        "financialMindset": "Description",
        "communication": "Description",
        "socialPosition": "Description",
        "bestChannel": "Letter/Phone/Email/Door"
    },
    "signals": ["Only real signals from search results"],
    "approach": {
        "opening": "Strategy",
        "keyMessages": "Key points",
        "avoid": "What to avoid",
        "timeline": "Timeline"
    },
    "scripts": {
        "letter": "Letter using only verified facts. Use [AGENT_NAME] and [AGENT_PHONE] placeholders.",
        "phone": "Phone script with verified facts only.",
        "door": "Door script with verified facts only.",
        "email": "Email with subject line first, then body. Verified facts only."
    }
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      temperature: 0,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search'
      }],
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Search for information about this property and owner. You MUST use the web_search tool - do not make anything up.

Owner: ${ownerName}
Property: ${propertyAddress}

First search for "${propertyAddress}" to find property records and tax data.
Then search for "${ownerName}" to find their occupation and background.`
      }]
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
    await saveToCache(ownerName, propertyAddress, result);

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

app.get('/api/profile/:userId', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });
  const { data, error } = await supabase.from('profiles').select('*').eq('id', req.params.userId).single();
  if (error) return res.status(404).json({ error: 'Profile not found' });
  res.json(data);
});

app.post('/api/profile/:userId/increment', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });
  const { data: profile } = await supabase.from('profiles').select('signals_used').eq('id', req.params.userId).single();
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const { data, error } = await supabase.from('profiles').update({ signals_used: (profile.signals_used || 0) + 1 }).eq('id', req.params.userId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const { priceId, userId, email } = req.body;
  try {
    let customerId;
    if (supabase && userId) {
      const { data: profile } = await supabase.from('profiles').select('stripe_customer_id').eq('id', userId).single();
      if (profile?.stripe_customer_id) customerId = profile.stripe_customer_id;
    }
    if (!customerId) {
      const customer = await stripe.customers.create({ email });
      customerId = customer.id;
      if (supabase && userId) await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', userId);
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
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/webhook', async (req, res) => {
  if (!stripe || !supabase) return res.status(500).send('Not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    if (userId) {
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const priceId = subscription.items.data[0]?.price.id;
      await supabase.from('profiles').update({
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        subscription_status: 'active',
        plan: 'pro',
        signals_limit: 50,
        signals_used: 0
      }).eq('id', userId);
    }
  }
  res.json({ received: true });
});

app.get('/api/cache/clear', async (req, res) => {
  if (!supabase) return res.json({ status: 'No cache' });
  await supabase.from('signals_cache').delete().neq('cache_key', '');
  res.json({ status: 'Cache cleared' });
});

app.post('/api/cache/clear', async (req, res) => {
  if (!supabase) return res.json({ status: 'No cache' });
  await supabase.from('signals_cache').delete().neq('cache_key', '');
  res.json({ status: 'Cache cleared' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', supabase: !!supabase, stripe: !!stripe, anthropic: !!process.env.ANTHROPIC_API_KEY });
});

app.get('/', (req, res) => res.sendFile('index.html', { root: './public' }));

app.listen(PORT, () => {
  console.log(`SellerSignal running on port ${PORT}`);
  console.log(`Supabase: ${supabase ? 'connected' : 'not configured'}`);
});
