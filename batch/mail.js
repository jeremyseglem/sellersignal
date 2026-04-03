// SellerSignal Direct Mail System
// Generates personalized 6-letter sequences using Claude, sends via Lob API

const LETTER_PROMPT = (agent, seller, position) => `You are writing a 6-letter direct mail sequence for a luxury real estate agent. These letters must sound like they were written by a top-producing agent who does $30M+ in annual volume and specializes in the upper tier of their market. NOT a marketing department. NOT a template service. A real person who did their homework on THIS specific owner.

VOICE AND STYLE RULES — NON-NEGOTIABLE:
- Write like a confident, intelligent person having a direct conversation. No fluff. No filler. No corporate speak.
- NEVER use the word "homeowner." Use their name.
- NEVER use phrases like "exciting opportunity," "don't miss out," "act now," "hot market," or any phrase that sounds like it came from a postcard.
- NEVER use bullet points, bold text, or formatting tricks. This is a letter, not a brochure.
- Lead with something specific about THEIR property, THEIR neighborhood, THEIR situation. Show you know the area.
- Be direct but never desperate. You're offering expertise, not begging for business.
- The tone should feel like you're writing to a peer — respectful, informed, unhurried.
- Short paragraphs. Three to four sentences max. White space matters.
- Every letter should feel like it took 10 minutes to write specifically for this person, even though it didn't.
- End each letter with JUST the agent's name and phone number on their own line. No "Sincerely" or "Best regards" or "Warm regards." Just the name and number.

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
Letter 1 — THE INTRODUCTION: You noticed their property. You work this area. You're not asking for anything — you're planting a flag. Reference something real about the property, the street, the neighborhood. Close with "when the timing is right, I'm here."
Letter 2 — THE MARKET INSIGHT: Share a genuine market observation relevant to their specific property. A recent comparable sale nearby, a trend in their neighborhood, something they'd actually want to know. Position yourself as someone paying attention to their market.
Letter 3 — THE QUIET PROOF: Reference a situation you've handled — generalized. "I recently worked with a family in a similar position..." Make selling feel normal, well-managed, and private. No bragging — just quiet competence.
Letter 4 — THE WINDOW: Something has shifted in their market. Include a placeholder {{RECENT_COMP}} for a real comparable sale to be inserted at send time. Create a sense that the market has a rhythm and you understand it.
Letter 5 — THE DIRECT ASK: "I'd welcome fifteen minutes of your time." Offer something specific — a confidential market analysis, a private valuation, a no-strings conversation. Make it easy to say yes.
Letter 6 — THE OPEN DOOR: Acknowledge you've reached out a few times. No guilt. No pressure. "When the timing is right, I'm here." Leave them thinking about you, not annoyed by you.

NAME FORMATTING: For trusts, use the family name ("SMITH FAMILY TRUST" becomes "Mr. Smith"). For "LAST, FIRST" format, use first name. For entities, address the principal or use "Dear [simplified entity name]."

EACH LETTER: 120-180 words. Fits on one page with letterhead. Feels like a personal note, not a form letter.

Respond with ONLY a JSON array of 6 objects:
[{"position":1,"subject":"Introduction","body":"..."},{"position":2,...}]

The "subject" is for internal tracking. The "body" is the full letter text exactly as printed.`;

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

// Format letter body as HTML for Lob — clean, minimal, branded
function letterToHtml(body, agent) {
  return `<!DOCTYPE html>
<html>
<head>
<style>
  @page { size: 8.5in 11in; margin: 0; }
  body {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 11pt;
    line-height: 1.7;
    color: #1a1a1a;
    margin: 0;
    padding: 0;
  }
  .letter {
    width: 8.5in;
    min-height: 11in;
    padding: 0.85in 1in 0.75in 1in;
    position: relative;
  }
  .letterhead {
    padding-bottom: 14pt;
    margin-bottom: 20pt;
    border-bottom: 0.5pt solid #c4a87c;
  }
  .lh-name {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 13pt;
    font-weight: 600;
    color: #1a1a1a;
    letter-spacing: 0.03em;
  }
  .lh-detail {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 8pt;
    color: #999;
    letter-spacing: 0.05em;
    margin-top: 3pt;
  }
  .body p {
    margin: 0 0 11pt 0;
  }
  .sign {
    margin-top: 22pt;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }
  .sign-name {
    font-size: 11pt;
    font-weight: 600;
    color: #1a1a1a;
  }
  .sign-phone {
    font-size: 9pt;
    color: #777;
    margin-top: 2pt;
  }
</style>
</head>
<body>
<div class="letter">
  <div class="letterhead">
    <div class="lh-name">${agent.name || ''}</div>
    <div class="lh-detail">${agent.brokerage || ''}${agent.phone ? ' · ' + agent.phone : ''}${agent.email ? ' · ' + agent.email : ''}</div>
  </div>
  <div class="body">
    ${body.split('\n').filter(l => l.trim()).map(p => `<p>${p}</p>`).join('\n    ')}
  </div>
</div>
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
      await supabase.from('mail_enrollments')
        .update({ status: 'completed' })
        .eq('id', enrollment.id);
      continue;
    }
    
    // Get agent profile for return address
    const { data: agentProfile } = await supabase.from('agent_profiles')
      .select('*')
      .eq('agent_id', enrollment.agent_id)
      .single();
    
    if (!agentProfile?.return_address) {
      continue; // Can't send without a return address
    }
    
    const letter = enrollment.mail_letters?.find(l => l.position === nextPos);
    if (!letter) continue;
    
    try {
      let bodyHtml = letter.body_html;
      
      const lobResult = await sendViaLob(lobApiKey, {
        subject: letter.subject,
        html: bodyHtml,
      }, {
        name: enrollment.owner_name,
        address_line1: enrollment.mailing_address,
        address_line2: undefined,
        city: enrollment.mailing_city,
        state: enrollment.mailing_state,
        zip: enrollment.mailing_zip,
      }, {
        name: agentProfile.agent_name,
        address_line1: agentProfile.return_address,
        city: agentProfile.return_city,
        state: agentProfile.return_state,
        zip: agentProfile.return_zip,
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
      
      sent++;
    } catch(e) {
      errors.push({ enrollment: enrollment.id, error: e.message });
    }
  }
  
  return { sent, errors };
}

module.exports = { generateLetterSequence, letterToHtml, sendViaLob, processMailQueue };
