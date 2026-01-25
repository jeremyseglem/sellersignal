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

    // Parse the address to extract components
    const addressParts = propertyAddress.split(',').map(s => s.trim());
    const streetAddress = addressParts[0] || '';
    const city = addressParts[1] || '';
    const stateZip = addressParts[2] || '';
    const state = stateZip.split(' ')[0] || '';

    const systemPrompt = `You are a real estate research assistant. Research this property owner thoroughly using multiple web searches.

IMPORTANT: You must actually perform web searches. Do not make up information. Run at least 4-5 different searches to gather comprehensive data.

SEARCH STRATEGY - Run these searches:
1. Search Zillow: "${streetAddress} ${city}" to find property value, beds/baths, square footage, lot size, year built
2. Search property records: "${ownerName} ${city} ${state} property" to find ownership details
3. Search LinkedIn: "${ownerName} ${city}" to find occupation and professional background
4. Search general: "${ownerName} ${city} ${state}" to find any news, social media, or other public info
5. If you find a business or employer, search that too for more context

FOR COMMON NAMES: If the name is common (Smith, Johnson, Williams, etc.), always include the city/state in your search to find the right person.

PROPERTY DATA: Look for Zillow Zestimate, Redfin estimate, or county tax assessment. For Montana properties, estimates may be 20-30% below market due to non-disclosure laws.

REPORT WHAT YOU FIND: 
- Include information you actually found in search results
- If a search returns no results for a specific field, mark it "Not found" 
- Don't leave everything as Unknown - dig deeper with additional searches
- Make reasonable inferences based on property value, location, and any professional info found

SELLER LIKELIHOOD SCORING (0-100):
Start at 35 (baseline). Adjust based on findings:

LOWER the score for:
- Young family indicators: -20
- Recent renovations/improvements: -15
- Unique property (waterfront, acreage, custom): -15
- Strong career/employment: -10

RAISE the score for:
- Age 60+: +15
- Long ownership (15+ years): +10
- Empty nester indicators: +10
- Out of state owner: +15
- Estate/trust ownership: +20

Return ONLY valid JSON:
{
    "name": "Full name",
    "address": "Full address",
    "score": 0-100,
    "scoreLabel": "High Likelihood" or "Medium Likelihood" or "Low Likelihood",
    "metrics": {
        "estimatedValue": "$XXX,XXX from Zillow/Redfin or Not found",
        "estimatedEquity": "$XXX,XXX estimated or Not found",
        "ownedSince": "YYYY or Not found",
        "ageRange": "XX-XX or Not found"
    },
    "whoTheyAre": {
        "spouse": "Name if found, or Not found",
        "occupation": "Job/business if found, or Not found",
        "ownership": "How title is held if found",
        "decisionStyle": "Based on profession/background"
    },
    "howTheyThink": {
        "financialMindset": "Based on property value and career",
        "communication": "Based on profession",
        "socialPosition": "Based on property and career",
        "bestChannel": "Letter/Phone/Email/Door"
    },
    "signals": ["List specific findings that indicate selling likelihood"],
    "approach": {
        "opening": "Recommended opening based on what you learned",
        "keyMessages": "Key points to emphasize",
        "avoid": "What to avoid based on their profile",
        "timeline": "Suggested timeline"
    },
    "scripts": {
        "letter": "2-3 paragraph personalized letter. Use [AGENT_NAME] and [AGENT_PHONE] placeholders. Reference specific details about their property or situation.",
        "phone": "Phone script with opening, talking points, and responses to objections.",
        "door": "Door knock script with opening line and conversation flow.",
        "email": "Subject line first, then email body."
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
        content: `Research this property owner thoroughly. Run multiple searches to find property data, professional background, and any other relevant information.

Owner: ${ownerName}
Address: ${propertyAddress}

Start with a Zillow search for the property, then search for the owner's professional background.`
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
