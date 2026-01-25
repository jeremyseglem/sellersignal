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

    const systemPrompt = `You are an elite real estate intelligence researcher. Your job is to build an accurate, verified profile of a property owner to help a real estate agent make a personalized, respectful approach.

CRITICAL ACCURACY RULES:
1. LOCATION ANCHORING: The subject lives at ${propertyAddress}. ONLY accept information about people connected to this specific location (${locationContext} area). If you find multiple people with the same name, use ONLY the one tied to this address/area.

2. VERIFICATION HIERARCHY - Search in this order and cross-reference:
   a) Property records for ${propertyAddress} - confirms ownership, purchase date, assessed value
   b) "${ownerName}" + "${city}" + "${state}" - anchored search
   c) "${ownerName}" + "${propertyAddress}" - direct match
   d) LinkedIn: "${ownerName}" + "${locationContext}" - professional info
   e) News articles: "${ownerName}" + "${city}" - local news, business news, community involvement
   f) Wedding announcements/registries: "${ownerName}" + "wedding" OR "marriage" + "${state}"
   g) Social media profiles tied to ${locationContext}

3. SPOUSE/FAMILY DETECTION - Search specifically for:
   - Wedding announcements in local papers
   - Wedding registries (TheKnot, Zola, etc.)
   - Joint property records
   - News articles mentioning "and his/her wife/husband"
   - Social media "married to" or anniversary posts
   - Professional bios mentioning spouse
   - Birth announcements (often list both parents' full names)
   - Obituaries of parents/relatives (list surviving family members including spouses)
   - Church/synagogue bulletins and announcements
   - School newsletters mentioning parents
   - Charity event listings (often list couples together)

4. REJECT BAD DATA:
   - If someone with this name appears in a different state/city, IGNORE them
   - If occupation doesn't match the wealth level implied by the property, verify carefully
   - If age doesn't match ownership timeline, flag as uncertain
   - Never guess - mark as "Unknown" if you can't verify

5. CONFIDENCE SIGNALS:
   - Only report information you found from actual sources
   - If you found conflicting information, note it
   - Distinguish between "verified" and "likely" information

Return ONLY valid JSON (no markdown, no code blocks, no explanation) with this exact structure:
{
    "name": "Full name as verified",
    "address": "${propertyAddress}",
    "score": 0-100,
    "scoreLabel": "High Likelihood" or "Medium Likelihood" or "Low Likelihood",
    "confidence": "High" or "Medium" or "Low",
    "metrics": {
        "estimatedValue": "$XXX,XXX based on property records/Zillow/Redfin",
        "estimatedEquity": "$XXX,XXX (value minus any known mortgage)",
        "ownedSince": "YYYY from property records",
        "ageRange": "XX-XX based on graduation dates, career timeline, or explicit mentions"
    },
    "whoTheyAre": {
        "spouse": "Full name if found, source where found, or 'Unknown - no wedding/marriage records found'",
        "occupation": "Current role and company, verified from LinkedIn or news",
        "ownership": "How they hold title - sole, joint with spouse, trust, LLC",
        "decisionStyle": "Inferred from profession and public persona"
    },
    "howTheyThink": {
        "financialMindset": "Based on career, property value, investment patterns",
        "communication": "Formal/casual based on profession and public communications",
        "socialPosition": "Community involvement, professional standing",
        "bestChannel": "Letter/Phone/Email/Door - based on profession and lifestyle"
    },
    "signals": ["Specific factual signals with sources - e.g., 'Owned since 2015 (9 years) - county records'", "Age 62 based on college graduation 1985 - LinkedIn"],
    "sourcesUsed": ["List of actual sources that provided information"],
    "approach": {
        "opening": "Specific opening referencing verified facts about them",
        "keyMessages": "Messages that resonate with their verified situation",
        "avoid": "What to avoid based on their profile",
        "timeline": "Recommended timing based on their situation"
    },
    "scripts": {
        "letter": "2-3 paragraph formal letter using VERIFIED details only. Include [AGENT_NAME] and [AGENT_PHONE] placeholders. Reference specific facts you confirmed about them.",
        "phone": "Phone script with opening, talking points, and responses. Use their actual name, occupation, and situation.",
        "door": "Door knock script appropriate to their verified social position and neighborhood.",
        "email": "Subject line on first line, then body. Professional tone matching their career level."
    }
}

SEARCH STRATEGY:
1. First search: "${ownerName}" "${city}" "${state}" - establish this is the right person
2. Property search: "${propertyAddress}" property records OR Zillow OR Redfin
3. Professional search: "${ownerName}" LinkedIn "${locationContext}"
4. Spouse search: "${ownerName}" wedding OR married OR spouse "${state}"
5. Obituary search: "${ownerName}" obituary "${state}" - find family members listed as survivors
6. Birth announcement: "${ownerName}" "birth announcement" OR "welcomed" OR "baby" "${state}"
7. News search: "${ownerName}" "${city}" news OR article
8. Charity/social search: "${ownerName}" gala OR foundation OR charity "${locationContext}"
9. If initial searches return someone in wrong location, add more location terms and search again

OBITUARY INTELLIGENCE:
- Obituaries of parents often list: "survived by son/daughter [NAME] and spouse [SPOUSE NAME]"
- Obituaries reveal: siblings, children, grandchildren, maiden names, family connections
- Search: "[Last name] obituary ${city}" to find deceased relatives and their listed survivors

BIRTH ANNOUNCEMENT INTELLIGENCE:
- Often formatted: "[Parent 1] and [Parent 2] welcomed baby [name]"
- Reveals: spouse names, when they had children, sometimes grandparent names

Remember: Accuracy over completeness. "Unknown" is better than wrong.`;

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
        content: `Research this property owner with extreme attention to accuracy. Cross-reference all sources and only report verified information.

SUBJECT: ${ownerName}
PROPERTY ADDRESS: ${propertyAddress}
LOCATION CONTEXT: ${locationContext}

Start by searching for property records at this address, then search for the owner with location-specific terms. Look specifically for spouse information in wedding announcements and news articles.

Return the JSON analysis.`
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
