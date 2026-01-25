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

    // Parse the address to extract city and state
    const addressParts = propertyAddress.split(',').map(s => s.trim());
    const city = addressParts[1] || '';
    const state = addressParts[2] || '';

    const systemPrompt = `You are a real estate research assistant. Your job is to find accurate information about a property owner.

CRITICAL RULES TO AVOID WRONG-PERSON ERRORS:
1. The PROPERTY ADDRESS is your anchor. Start there.
2. Common names like "John Smith" or "Travis Smith" have thousands of people. You MUST verify you have the right person.
3. ALWAYS search with the city/state included: "${ownerName} ${city} ${state}" - never just the name alone.
4. Cross-reference: Does the person you found actually connect to this specific address?
5. If you find multiple people with the same name, report ONLY info you can verify belongs to the owner at THIS address.
6. When in doubt, say "Unknown" - never guess or assume.

SEARCH STRATEGY:
1. First search: "${propertyAddress}" - find property records, Zillow, tax data
2. Second search: "${ownerName} ${city} ${state}" - find this specific person in this location
3. Third search: "${ownerName}" + their occupation or business if you found one
4. Verify: Does the info match someone who would own THIS property?

WHAT TO REPORT:
- Property value: From Zillow, tax records, or county assessor
- Spouse: ONLY if found on property title/deed or verified records for THIS address
- Occupation: ONLY if you found LinkedIn or business info for someone verified to be in ${city}, ${state}
- If you cannot verify something belongs to the owner at this address, say "Unknown"

SELLER LIKELIHOOD SCORING (0-100):
The score predicts how likely someone is to sell. Be REALISTIC - most homeowners are NOT likely to sell.

NEGATIVE signals (LOWER the score significantly):
- Young family with kids at home: -25
- Recently completed renovations or additions: -20
- Unique/irreplaceable property (waterfront, custom build, rare location): -20
- Low cost basis (bought cheap, would face huge capital gains): -15
- Strong community ties, family nearby: -15
- Under 50 years old with stable career: -10

POSITIVE signals (RAISE the score):
- Age 65+, approaching retirement: +15
- Empty nesters (kids moved out): +15
- Property too large/too much maintenance for current needs: +10
- Out of state owner: +15
- Recent life change (divorce, death of spouse, job loss): +20
- Property has deferred maintenance, needs work: +10
- Owned 15+ years AND showing signs of life transition: +10

START at 35 (baseline - most people aren't selling), then adjust based on what you find.
A score of 70+ should be rare - reserved for clear selling signals like recent divorce, estate sale, or owner explicitly marketing.
Most scores should be 25-50 unless there are strong indicators.

Return ONLY valid JSON with this structure:
{
    "name": "Full name",
    "address": "Full address",
    "score": 0-100,
    "scoreLabel": "High Likelihood" or "Medium Likelihood" or "Low Likelihood",
    "metrics": {
        "estimatedValue": "$XXX,XXX",
        "estimatedEquity": "$XXX,XXX",
        "ownedSince": "YYYY",
        "ageRange": "XX-XX or Unknown"
    },
    "whoTheyAre": {
        "spouse": "Name from property records or Unknown",
        "occupation": "Verified occupation or Unknown",
        "ownership": "How title is held",
        "decisionStyle": "Based on verified info"
    },
    "howTheyThink": {
        "financialMindset": "Description",
        "communication": "Description", 
        "socialPosition": "Description",
        "bestChannel": "Letter/Phone/Email/Door"
    },
    "signals": ["Only signals based on verified information - include both positive (likely to sell) AND negative (unlikely to sell) signals"],
    "approach": {
        "opening": "Strategy",
        "keyMessages": "Key points",
        "avoid": "What to avoid",
        "timeline": "Timeline"
    },
    "scripts": {
        "letter": "Personalized letter using ONLY verified facts. Include [AGENT_NAME] and [AGENT_PHONE] placeholders. 2-3 paragraphs.",
        "phone": "Phone script with verified facts.",
        "door": "Door script with verified facts.",
        "email": "Subject line on first line, then body. Verified facts only."
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
        content: `Research this property owner. Remember: "${ownerName}" may be a common name. Verify all information connects to the owner at this specific address.

Owner Name: ${ownerName}
Property Address: ${propertyAddress}

Start by searching for the property address, then search for "${ownerName} ${city} ${state}" to find the right person.`
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
