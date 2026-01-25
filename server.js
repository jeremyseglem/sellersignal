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
        max_tokens: 4000,
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
// PROSPECT RESEARCH ENDPOINT
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
    const areaContext = addressParts.slice(1).join(', ');

    // ============================================
    // PROPRIETARY PROMPT - KEPT SERVER-SIDE ONLY
    // ============================================
    const researchPrompt = `You are SellerSignal, an elite real estate intelligence system that builds comprehensive psychological profiles of property owners to help agents understand who they're dealing with and how to approach them effectively.

PROSPECT: ${ownerName}
PROPERTY: ${propertyAddress}

CRITICAL INSTRUCTION: The user has confirmed ${ownerName} owns ${propertyAddress}. This is fact. Your job is deep intelligence gathering.

=== SEARCH STRATEGY (Follow this exactly for consistent results) ===

SEARCH 1: "${streetAddress}" "${city}" site:zillow.com
- Extract: Zestimate value, beds/baths, sq ft, year built, sale history
- IMPORTANT: For Montana properties, Zillow Zestimates are often 20-40% below market value due to non-disclosure state laws. If the property is in Montana, note this and consider adjusting estimate upward.

SEARCH 2: "${streetAddress}" "${city}" site:redfin.com OR site:realtor.com
- Extract: Redfin estimate, property details, listing history
- Cross-reference with Zillow for more accurate valuation

SEARCH 3: "${ownerName}" "${city}" "${state}"
- Extract: Current employer, job title, LinkedIn profile info, professional background

SEARCH 4: "${ownerName}" spouse OR wife OR husband OR family "${city}"
- Extract: Spouse name, spouse occupation, family business connections, parents' backgrounds if findable

SEARCH 5: "${ownerName}" obituary OR death OR "passed away" OR funeral "${city}" "${state}"
- CRITICAL: Check if the owner or their spouse is deceased
- Look for obituaries, funeral home notices, memorial pages
- If deceased, note the date and update the profile accordingly

=== DATA PRIORITY (Use this hierarchy for consistent results) ===

For property values: 
- Zillow Zestimate > Redfin Estimate > County Records > Other sources
- MONTANA EXCEPTION: Montana is a non-disclosure state. Zillow/Redfin estimates are often significantly low. If in MT, search for comparable recent sales in the area and adjust estimate upward by 20-40% if Zestimate seems unreasonably low for the neighborhood.

For employment: LinkedIn (current) > Company website > News articles > Other sources
For family info: LinkedIn connections > News/society pages > Public records > Other sources
For death/obituary: Funeral home sites > Legacy.com > Local newspaper obituaries > Find a Grave

IMPORTANT: If you find conflicting information, ALWAYS use the most recent source. Note the date of information when available.

CRITICAL - DEATH VERIFICATION: If you find evidence that the owner OR their spouse is deceased:
- Set the appropriate field to indicate deceased status
- Include date of death if available
- This is a HIGH-PRIORITY motivation signal (estate sale, widow/widower may want to downsize)

=== PSYCHOLOGICAL PROFILE REQUIREMENTS ===

Go deep on understanding WHO this person is:

1. FINANCIAL PSYCHOLOGY
   - Are they self-made or inherited wealth?
   - Do they appear to live below/at/above their means?
   - Spouse's financial background - married into money?
   - Family wealth indicators (parents' businesses, trust fund signs)

2. DECISION-MAKING STYLE
   - Career path suggests: analytical vs intuitive?
   - Industry background implies: risk-taker or conservative?
   - Age/life stage: what pressures might they face?

3. SOCIAL DYNAMICS
   - Who influences their decisions? (spouse, parents, business partners)
   - Social status indicators (club memberships, charity boards, etc.)
   - Community ties - deep roots or transient?

4. MOTIVATION TRIGGERS
   - Life events that could trigger a sale (retirement approaching, kids gone, divorce, job change)
   - Financial events (inheritance coming, business sale, stock vesting)
   - Property-specific (maintenance burden, neighborhood changes, equity position)

=== OUTPUT FORMAT ===

Return ONLY valid JSON, no markdown, no explanation:

{
  "ownerProfile": {
    "occupation": "Current job title - be specific",
    "employer": "Current employer name",
    "employmentHistory": "Brief career trajectory",
    "estimatedAge": "Age range based on graduation dates, career length",
    "background": "2-3 sentence professional background summary"
  },
  "familyConnections": {
    "spouse": {
      "name": "Spouse name if found, null if not",
      "occupation": "Spouse job/background",
      "familyWealth": "Any indicators of spouse's family wealth/connections"
    },
    "parents": {
      "information": "Any info on parents' businesses, wealth, background",
      "wealthIndicators": "Trust fund signs, family business, inherited property, etc."
    },
    "keyInfluencers": "Who likely influences this person's major decisions"
  },
  "psychologicalProfile": {
    "financialMindset": "Self-made vs inherited, conservative vs aggressive, etc.",
    "decisionStyle": "Analytical, emotional, consultative, impulsive, etc.",
    "socialPosition": "Status-conscious, understated, community-focused, etc.",
    "likelyPressurePoints": "What life/financial pressures might they face",
    "communicationPreference": "How they likely prefer to be approached"
  },
  "propertyIntel": {
    "estimatedValue": "$XXX,XXX (source: Zillow/Redfin/etc)",
    "lastSaleDate": "Date",
    "lastSalePrice": "$XXX,XXX",
    "equityEstimate": "Estimated equity based on sale price vs current value",
    "propertyType": "Type",
    "bedsBaths": "X bed / X bath",
    "squareFeet": "X,XXX sq ft",
    "yearBuilt": "Year",
    "listingHistory": "Has it been listed before? When? For how long?"
  },
  "motivationSignals": [
    {"signal": "Specific signal", "type": "positive|neutral|negative", "weight": "high|medium|low", "reasoning": "Why this matters"}
  ],
  "score": 50,
  "scoreCategory": "high|medium|low",
  "scoreSummary": "2-3 sentences explaining the score with specific evidence",
  "detailedAnalysis": "3-4 paragraphs: First paragraph about the property and equity situation. Second paragraph about the owner's professional/financial situation. Third paragraph about family dynamics and decision influences. Fourth paragraph synthesizing everything into a prediction about selling likelihood and timing.",
  "outreach": {
    "doorknock": "5-6 sentence script that uses psychological insights. Reference specific details that show you've done research. Match their likely communication style.",
    "phone": "6-7 sentence script. Professional but personalized. Use a hook based on their specific situation.",
    "letter": "3 paragraphs. Personalized opening that shows you know who they are (without being creepy). Value proposition that addresses their likely concerns. Soft CTA that matches their decision style.",
    "email": "Subject: [Compelling, personalized subject line]\\n\\n3 paragraph email that demonstrates understanding of their situation and offers genuine value."
  },
  "approachStrategy": {
    "bestChannel": "door|phone|mail|email - and why",
    "bestTiming": "When to approach based on their likely schedule/life situation",
    "keyTalkingPoints": ["Point 1 specific to them", "Point 2 specific to them", "Point 3 specific to them"],
    "avoidTopics": ["What not to bring up and why"],
    "decisionProcess": "How they likely make big decisions - who to involve, what they need to see"
  },
  "researchNotes": "Data sources used, dates of information, confidence level in findings",
  "ownershipFlag": null
}

=== SCORING GUIDELINES (Apply consistently) ===

Start at 45 (baseline unknown), then adjust:

PROPERTY FACTORS:
- Owned 10+ years: +15
- Owned 5-10 years: +10
- Owned < 3 years: -15
- High equity (>50%): +10
- Listed before, didn't sell: +15
- Property needs updates (20+ years old): +5

OWNER FACTORS:
- Age 60+: +10
- Age 30-45 with kids: -10
- Recent job change: +10
- Approaching retirement: +15
- Divorce indicators: +20
- Out of state owner: +15
- Owner is deceased: +25 (estate sale likely)
- Spouse recently deceased (within 2 years): +20 (may want to downsize/relocate)

FAMILY FACTORS:
- Empty nesters: +10
- Inherited property: +10
- Family wealth (less price sensitive): +5
- Strong local family ties: -10
- Widow/widower living alone: +15

IMPORTANT - DECEASED PERSONS:
- If the named OWNER is deceased, still provide the profile but note prominently in ownershipFlag and scoreSummary that this is likely an estate property
- If the SPOUSE is deceased, this is a major motivation signal - note it prominently and factor into approach strategy (be sensitive, don't mention spouse directly)

If and ONLY if you find clear evidence that this person CANNOT be the owner (person is deceased, lives permanently in another country, name returns zero results anywhere), set:
"ownershipFlag": "Brief explanation of the contradiction"

Otherwise ownershipFlag should be null.

Return ONLY the JSON object. Start with { and end with }`;

    // Call Anthropic API with retry logic
    const response = await callAnthropicWithRetry(researchPrompt);

    // Extract text from response
    let fullText = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        fullText += block.text;
      }
    }

    if (!fullText.trim()) {
      return res.status(500).json({ error: 'No results returned. Please try again.' });
    }

    // Parse JSON response
    const parsed = parseJSON(fullText);

    if (!parsed) {
      return res.status(500).json({ error: 'Failed to parse results. Please try again.' });
    }

    // Save to cache
    await saveToCache(ownerName, propertyAddress, parsed);

    // Save to history if logged in
    if (userId && supabase) {
      await supabase.from('signals_history').insert({
        user_id: userId,
        owner_name: ownerName,
        property_address: propertyAddress,
        score: parsed.score
      });
    }

    res.json(parsed);

  } catch (error) {
    console.error('Research error:', error);
    
    if (error.status === 429 || (error.message && error.message.includes('rate'))) {
      return res.status(429).json({ error: 'High demand right now. Please wait 30 seconds and try again.' });
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
    .replace(/\\n/g, '\\n')
    .replace(/\s+/g, ' ')
    .trim();

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('JSON parse error:', e.message);
    console.log('Raw:', jsonStr.substring(0, 500));

    const scoreMatch = jsonStr.match(/"score"\s*:\s*(\d+)/);
    if (scoreMatch) {
      return {
        ownerProfile: { occupation: null, employer: null, photoUrl: null, estimatedAge: null, background: null },
        familyConnections: { spouse: null, parents: null, keyInfluencers: null },
        psychologicalProfile: null,
        propertyIntel: { estimatedValue: 'Unknown', lastSaleDate: 'Unknown', lastSalePrice: 'Unknown' },
        motivationSignals: [{ signal: 'Limited data available', type: 'neutral', weight: 'medium' }],
        score: parseInt(scoreMatch[1]),
        scoreCategory: parseInt(scoreMatch[1]) >= 65 ? 'high' : parseInt(scoreMatch[1]) >= 40 ? 'medium' : 'low',
        scoreSummary: 'Analysis completed with limited data.',
        detailedAnalysis: 'Research completed but there was an issue formatting the full results.',
        outreach: {
          doorknock: 'Hi, I\'m a local real estate professional. I wanted to introduce myself and see if you\'ve considered what your home might be worth in today\'s market.',
          phone: 'Hi, this is [Your Name] with [Company]. I\'m reaching out to homeowners in your neighborhood to introduce myself.',
          letter: 'Dear Homeowner,\n\nI hope this letter finds you well. I\'m a local real estate professional who specializes in your neighborhood.\n\nPlease don\'t hesitate to reach out with any questions.',
          email: 'Subject: Quick question about your property\n\nHi,\n\nI\'m a local real estate professional reaching out to homeowners in your area.\n\nBest regards'
        },
        approachStrategy: null,
        researchNotes: 'Partial data retrieved',
        ownershipFlag: null
      };
    }
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
