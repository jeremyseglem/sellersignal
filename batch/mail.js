// SellerSignal Direct Mail System
// Generates personalized 6-letter sequences using Claude, sends via Lob API

const LETTER_PROMPT = (agent, seller, position) => `You are SellerSignal's direct mail copywriter. Write a 6-letter mail sequence for a real estate agent to send to a specific property owner over 6 months.

CRITICAL: These letters must feel personally written by the agent — NOT like marketing material. No logos, no bullet points, no "Dear Homeowner." These read like a handwritten note from someone who did their homework.

AGENT:
Name: ${agent.name}
Brokerage: ${agent.brokerage}
Phone: ${agent.phone}
Email: ${agent.email}

PROPERTY OWNER:
Name: ${seller.ownerName}
Property: ${seller.address}, ${seller.cityStateZip}
Owner Type: ${seller.cohort} (${seller.cohortLabel})
Assessed Value: $${(seller.totalValue || 0).toLocaleString()}
Mailing Address: ${seller.mailingAddress || 'Same as property'}
Out of State: ${seller.isOutOfState ? 'Yes — mails to ' + seller.ownerState : 'No'}
Absentee: ${seller.isAbsentee ? 'Yes' : 'No'}
Tenure: ${seller.tenureYears ? seller.tenureYears + ' years' : 'Unknown'}
${seller.deepSignalMotivation ? 'AI Analysis: ' + seller.deepSignalMotivation : ''}
${seller.deepSignalPsychology ? 'Seller Psychology: ' + seller.deepSignalPsychology : ''}

SEQUENCE STRUCTURE:
Letter 1 — WARM INTRODUCTION: Establish credibility and relevance. Reference something specific about their property or situation that shows you've done research. No ask, just "I noticed" + "I thought you'd want to know."
Letter 2 — VALUE DROP: Share a genuine market insight relevant to their specific property. A nearby sale, a trend, something they'd actually care about. Position yourself as a source of useful information.
Letter 3 — SOCIAL PROOF: Reference a similar situation you've handled (can be generalized). "I recently worked with a [similar owner type] in [area] who..." Make the transition feel normal and well-managed.
Letter 4 — MARKET TRIGGER: Reference a specific market condition that creates a window. Include a placeholder {{RECENT_COMP}} that will be filled with a real comparable sale at send time.
Letter 5 — DIRECT BUT SOFT ASK: "I'd welcome 15 minutes..." Make it easy to say yes. Offer something specific — a confidential market analysis, a no-obligation conversation.
Letter 6 — GRACEFUL CLOSE: Acknowledge you've reached out several times. Leave the door open warmly. "When the timing is right, I'm here."

EACH LETTER MUST:
- Start with "${seller.ownerName.split(',')[0].split(' ')[0]}," or a natural greeting using their name
- Be 150-200 words (fits a single page, feels personal not corporate)
- Reference the actual property address at least once
- Match the tone to the owner type (trust owner gets professional discretion, individual homeowner gets neighborly warmth, LLC gets business efficiency)
- End with the agent's name, phone, and a single line that feels human
- NEVER use the word "homeowner" — use their name
- NEVER use marketing language like "exciting opportunity" or "don't miss out"

Respond with ONLY a JSON array of 6 objects:
[{"position":1,"subject":"Introduction","body":"Dear..."},{"position":2,...}]

The "subject" is for internal tracking only (not printed). The "body" is the full letter text.`;

async function generateLetterSequence(anthropic, agent, seller) {
  const prompt = LETTER_PROMPT(agent, seller);
  
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });
  
  const text = (response.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
  const letters = JSON.parse(text);
  
  if (!Array.isArray(letters) || letters.length < 6) {
    throw new Error('Failed to generate 6 letters');
  }
  
  return letters.map((l, i) => ({
    position: l.position || i + 1,
    subject: l.subject || `Letter ${i + 1}`,
    body: l.body,
  }));
}

// Format letter body as HTML for Lob
function letterToHtml(body, agent) {
  return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 12pt; line-height: 1.6; color: #1a1a1a; max-width: 6.5in; margin: 0.75in auto; }
  p { margin-bottom: 12pt; }
  .signature { margin-top: 24pt; }
  .sig-name { font-weight: bold; }
  .sig-detail { font-size: 10pt; color: #555; }
</style>
</head>
<body>
${body.split('\n').filter(l => l.trim()).map(p => `<p>${p}</p>`).join('\n')}
</body>
</html>`;
}

// Send a letter via Lob API
async function sendViaLob(lobApiKey, letter, recipient, returnAddress) {
  const resp = await fetch('https://api.lob.com/v1/letters', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(lobApiKey + ':').toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      description: `SellerSignal — ${letter.subject} to ${recipient.name}`,
      to: {
        name: recipient.name,
        address_line1: recipient.address_line1,
        address_line2: recipient.address_line2 || undefined,
        address_city: recipient.city,
        address_state: recipient.state,
        address_zip: recipient.zip,
      },
      from: {
        name: returnAddress.name,
        address_line1: returnAddress.address_line1,
        address_city: returnAddress.city,
        address_state: returnAddress.state,
        address_zip: returnAddress.zip,
      },
      file: letter.html,
      color: false,
      mail_type: 'usps_first_class',
      merge_variables: letter.mergeVars || {},
    }),
  });
  
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Lob error: ${err.error?.message || resp.statusText}`);
  }
  
  return resp.json();
}

// Process all due mailings (called by cron)
async function processMailQueue(supabase, anthropic, lobApiKey) {
  const now = new Date();
  
  // Find all enrollments where next_send_at <= now and status = active
  const { data: due } = await supabase.from('mail_enrollments')
    .select('*, mail_letters(*)')
    .eq('status', 'active')
    .lte('next_send_at', now.toISOString())
    .order('next_send_at');
  
  if (!due?.length) return { sent: 0 };
  
  let sent = 0, errors = [];
  
  for (const enrollment of due) {
    const nextPos = enrollment.current_position + 1;
    if (nextPos > enrollment.total_letters) {
      // Sequence complete
      await supabase.from('mail_enrollments')
        .update({ status: 'completed' })
        .eq('id', enrollment.id);
      continue;
    }
    
    // Check agent has credits
    const { data: credits } = await supabase.from('mail_credits')
      .select('credits_remaining')
      .eq('user_id', enrollment.agent_id)
      .single();
    
    if (!credits || credits.credits_remaining <= 0) {
      continue; // Skip — no credits
    }
    
    // Get the letter for this position
    const letter = enrollment.mail_letters?.find(l => l.position === nextPos);
    if (!letter) continue;
    
    try {
      // TODO: Inject dynamic comp data into letter body if {{RECENT_COMP}} placeholder exists
      let bodyHtml = letter.body_html;
      
      // Send via Lob
      const lobResult = await sendViaLob(lobApiKey, {
        subject: letter.subject,
        html: bodyHtml,
      }, {
        name: enrollment.owner_name,
        address_line1: enrollment.mailing_address,
        city: enrollment.mailing_city,
        state: enrollment.mailing_state,
        zip: enrollment.mailing_zip,
      }, {
        // Return address — agent's brokerage
        name: enrollment.agent_id, // TODO: look up agent name
        address_line1: '', // TODO: agent return address
        city: '',
        state: '',
        zip: '',
      });
      
      // Log the send
      await supabase.from('mail_sends').insert({
        enrollment_id: enrollment.id,
        letter_id: letter.id,
        position: nextPos,
        lob_letter_id: lobResult.id,
        lob_url: lobResult.url,
        status: 'mailed',
        cost_cents: lobResult.expected_delivery_date ? 125 : 150, // estimate
      });
      
      // Update enrollment
      const nextSendAt = new Date();
      nextSendAt.setMonth(nextSendAt.getMonth() + 1);
      
      await supabase.from('mail_enrollments').update({
        current_position: nextPos,
        last_sent_at: now.toISOString(),
        next_send_at: nextSendAt.toISOString(),
      }).eq('id', enrollment.id);
      
      // Deduct credit
      await supabase.rpc('decrement_mail_credits', { agent: enrollment.agent_id });
      
      sent++;
    } catch(e) {
      errors.push({ enrollment: enrollment.id, error: e.message });
    }
  }
  
  return { sent, errors };
}

module.exports = { generateLetterSequence, letterToHtml, sendViaLob, processMailQueue };
