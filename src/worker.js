// Agentic Publicist — Single Cloudflare Worker
// Auth: Cloudflare Access (Zero Trust) — no auth code needed here
// Async pipeline: Queue Consumer handles brief → angles → pitches
//
// Journalist discovery: journalists are curated directly in D1 (not discovered
// via Hunter.io domain search). BEAT_KEYWORDS on each journalist row determines
// which angles they're matched to. Add journalists via the /journalists page.

// ============================================================
// CONSTANTS
// ============================================================

// Canonical beat names used in angle generation and journalist matching.
// These are labels, not domain lists. The journalist DB is the source of truth.
export const KNOWN_BEATS = [
  'marketing-tech',
  'home-services',
  'ai-automation',
  'flooring-industry',
  'small-business',
  'digital-marketing',
  'construction',
  'sc-local',       // SC local news reporters (The State, TV stations)
  'local-business', // Business reporters at local SC outlets
];

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// ============================================================
// UTILITIES
// ============================================================

export async function hashUrl(url) {
  const u = new URL(url);
  const normalized = u.origin + u.pathname;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function uid() {
  return crypto.randomUUID();
}

function now() {
  return Date.now();
}

export function filterEligibleJournalists(journalists) {
  return journalists.filter(j =>
    !j.last_contacted_at ||
    (Date.now() - j.last_contacted_at) > THIRTY_DAYS_MS
  );
}

// Find journalists from D1 whose beat_keywords overlap with an angle's beat.
// beat_keywords is a JSON array on each journalist row (e.g. ["marketing-tech","ai-automation"]).
export async function getJournalistsForBeat(beat, db) {
  // Pull all journalists — D1 has no JSON array search, so filter in JS.
  // Cap at 200 rows; the journalist DB stays small and curated.
  const rows = await db.prepare('SELECT * FROM journalists LIMIT 200').all().then(r => r.results || []);
  return rows.filter(j => {
    try {
      const keywords = JSON.parse(j.beat_keywords || '[]');
      return keywords.includes(beat);
    } catch {
      return false;
    }
  });
}

// ============================================================
// CLAUDE API
// ============================================================

async function callClaude(messages, systemText, env, { cacheSystem = false, maxTokens = 1024 } = {}) {
  const body = {
    model: 'claude-sonnet-5',
    max_tokens: maxTokens,
    // Sonnet 5 defaults to extended thinking, which returns a thinking block as
    // content[0] (no .text) and can yield empty/instructional output. Disable it
    // so content[0].text is the answer. (Same fix used in command-center + CRM.)
    thinking: { type: 'disabled' },
    messages,
  };

  if (systemText) {
    body.system = cacheSystem
      ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
      : systemText;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text') || data.content[0];
  return textBlock ? textBlock.text : '';
}

// Shared elite-publicist persona — mirrors ~/.claude/skills/publicist/SKILL.md so the
// worker pipeline reasons at the same level as the in-session /publicist skill.
// Kept as the stable system-prompt PREFIX (prompt-cached) with a per-call task appended.
const PUBLICIST_PERSONA = `You are an elite, world-class publicist and narrative strategist operating at the level of top-tier Hollywood PR firms, political communications war rooms, and high-growth startup launch teams. Your job is not to generate publicity ideas — it is to engineer public perception, attention momentum, credibility transfer, and cultural relevance.

How you think:
- Attention is warfare. Safe messaging is ignored; generic positioning dies unseen. Seek tension, contrast, unexpected framing, emotionally loaded hooks, curiosity gaps, and status dynamics.
- Narrative over information. Facts don't spread — stories do. Convert ordinary announcements into narratives people emotionally attach to. Frame the subject as category leader, challenger, protector, rebel, innovator, truth-teller, or movement-builder — whichever creates the most asymmetric attention.
- Think like a journalist. Before anything, ask: Why would anyone care? Why now? What makes this different? What emotional reaction does it trigger? Is this truly newsworthy or just self-promotion? What headline would a journalist actually publish?
- Find the protagonist and the proof. The strongest local stories have a human protagonist and a concrete, specific proof point (a real number, a real stake, a real outcome). Lead with those, never with the organization.
- Never sound corporate. No bloated PR language, fake enthusiasm, buzzwords, empty "mission" talk, or sanitized messaging. Write with clarity, precision, emotional intelligence, and strategic sharpness.
- Never fabricate. Do not invent quotes, statistics, names, or facts not present in the brief. If a detail would strengthen the story but isn't given, note the gap — don't manufacture it.`;

// Call 1 — Angle Generation
async function generateAngles(briefBody, entity, headlines, env) {
  const system = `${PUBLICIST_PERSONA}

Your current task: generate story angles for ${entity.name}.
Type: ${entity.type}
Expertise: ${entity.expertise_keywords}
Bio: ${entity.bio_long}

Rules:
- Generate story angles only, no pitches yet
- Each angle must be genuinely newsworthy, not promotional — carry a real tension, protagonist, or proof point
- Keep each "angle" to 1-2 tight sentences — punchy, not a paragraph
- Reference current news context where relevant
- Return ONLY the raw JSON array — no markdown fences, no preamble`;

  const user = `Brief: ${briefBody}
Today's date: ${new Date().toISOString().split('T')[0]}
Top headlines today: ${headlines.join(' | ')}

Return a JSON array of exactly 3 story angles:
[{"angle": "string", "beat": "one of: marketing-tech|home-services|ai-automation|flooring-industry|small-business|digital-marketing|construction|sc-local|local-business", "publication_type": "string"}]`;

  const text = await callClaude(
    [{ role: 'user', content: user }],
    system,
    env,
    { cacheSystem: true, maxTokens: 2000 }
  );

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Claude returned no JSON array for angles');
  return JSON.parse(match[0]);
}

// Call 3 — Pitch Drafting (per journalist)
async function draftPitch(journalist, entity, angle, briefBody, articleTitle, articleSnippet, env) {
  const outletType = journalist.outlet_type || 'journalist';
  const isGuestPitch = outletType === 'podcast' || outletType === 'blog';

  const taskRules = isGuestPitch
    ? `Your current task: draft ONE guest-booking pitch on behalf of ${entity.name} to the host of a ${outletType}. You are pitching a PERSON as a guest (or contributor), not a press story.
Entity bio: ${entity.bio_long}
Expertise: ${entity.expertise_keywords}

Rules:
- Open with why their AUDIENCE wins — the specific insight or story the guest brings, not the guest's résumé
- Propose 2-3 concrete talking points drawn from the brief (real numbers and stakes, not themes)
- Reference their recent episode/post (provided below) and why this fits their show specifically
- Make the ask explicit and low-friction (a 30-45 min recording, flexible scheduling)
- 150 words max for body
- Subject line 7 words max, no clickbait, no ALL CAPS
- Never fabricate quotes or statistics not in the brief
- Write in first person as if from ${entity.name}
- Return valid JSON only`
    : `Your current task: draft ONE media pitch on behalf of ${entity.name} to a specific journalist.
Entity bio: ${entity.bio_long}
Expertise: ${entity.expertise_keywords}

Rules:
- Open with the story hook / protagonist, not the announcement
- Reference a specific article the journalist wrote (provided below) and why THIS journalist at THIS publication is the right fit
- 150 words max for body
- Subject line 7 words max, no clickbait, no ALL CAPS
- Never fabricate quotes or statistics not in the brief
- Write in first person as if from ${entity.name}
- Return valid JSON only`;

  const system = `${PUBLICIST_PERSONA}

${taskRules}`;

  const user = `${isGuestPitch ? 'Host' : 'Journalist'}: ${journalist.name}, ${journalist.publication}
Their recent ${isGuestPitch ? 'episode/post' : 'article'}: "${articleTitle}" — ${articleSnippet || 'recent coverage'}

Brief: ${briefBody}
Story angle for this journalist: ${angle.angle}

Write: subject line + email body.
Return JSON: {"subject": "string", "body": "string"}`;

  const text = await callClaude(
    [{ role: 'user', content: user }],
    system,
    env,
    { cacheSystem: true, maxTokens: 1200 }
  );

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude returned no JSON for pitch');
  return JSON.parse(match[0]);
}

// Coverage sentiment scoring
async function scoreSentiment(headline, snippet, entityName, env) {
  const text = await callClaude(
    [{
      role: 'user',
      content: `Score the sentiment of this article mention about "${entityName}".
Headline: ${headline}
Snippet: ${snippet || ''}

Reply with exactly one word: positive, neutral, or negative.`
    }],
    null,
    env,
    { maxTokens: 10 }
  );
  const word = text.trim().toLowerCase();
  if (['positive', 'neutral', 'negative'].includes(word)) return word;
  return 'neutral';
}

// ============================================================
// GOOGLE NEWS RSS
// ============================================================

async function getTopHeadlines(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [];
    const re = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null && items.length < 5) {
      const title = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
      if (title) items.push(title);
    }
    return items;
  } catch {
    return [];
  }
}

async function getJournalistArticle(journalistName, publication) {
  const q = `${journalistName} site:${publication}`;
  const items = await getTopHeadlines(q);
  if (!items.length) return { title: 'recent coverage', snippet: '' };
  return { title: items[0], snippet: items[1] || '' };
}

// ============================================================
// RESEND
// ============================================================

async function sendPitchEmail(pitch, journalist, entity, env) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `${entity.name} <pitches@engageengine.ai>`,
      to: [journalist.email],
      subject: pitch.subject,
      text: pitch.body,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.id; // resend_email_id
}

// ============================================================
// TELEGRAM NOTIFICATIONS
// ============================================================

async function telegram(text, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch { /* non-critical */ }
}

// ============================================================
// QUEUE CONSUMER — Pipeline
// ============================================================

async function processBrief(message, env) {
  const { briefId } = message.body;
  const db = env.DB;

  // Idempotency check (brief.status field pattern)
  const brief = await db.prepare('SELECT * FROM briefs WHERE id=?').bind(briefId).first();
  if (!brief) { await message.ack(); return; }

  if (brief.status === 'complete') {
    await message.ack();
    return;
  }

  if (brief.status === 'error') {
    // Clean up partial pitches and retry
    await db.prepare('DELETE FROM pitches WHERE brief_id=?').bind(briefId).run();
  }

  // Mark processing
  await db.prepare('UPDATE briefs SET status=? WHERE id=?').bind('processing', briefId).run();

  const entity = await db.prepare('SELECT * FROM entities WHERE id=?').bind(brief.entity_id).first();
  if (!entity) {
    await db.prepare("UPDATE briefs SET status='error' WHERE id=?").bind(briefId).run();
    await message.ack();
    return;
  }

  const updateProgress = async (steps) => {
    await db.prepare('UPDATE briefs SET progress_log=? WHERE id=?')
      .bind(JSON.stringify(steps), briefId).run();
  };

  let steps = [
    { step: 'Analyzing brief', done: false, ts: null },
    { step: 'Generating story angles', done: false, ts: null },
    { step: 'Matching journalists by beat', done: false, ts: null },
    { step: 'Drafting pitches', done: false, ts: null },
  ];

  try {
    // Step 1: Fetch current headlines for context
    steps[0].done = true; steps[0].ts = now();
    await updateProgress(steps);

    // Why-now context: derive the news query from the ENTITY, not a hardcoded
    // marketing-tech string — a nonprofit client needs arts/community headlines,
    // not AI-automation headlines.
    let newsQuery = 'marketing technology AI automation';
    try {
      const kw = JSON.parse(entity.expertise_keywords || '[]');
      if (kw.length) newsQuery = kw.slice(0, 3).join(' ');
    } catch { /* fall back to default */ }
    const headlines = await getTopHeadlines(newsQuery);

    // Step 2: Generate angles (Call 1 — cached system prompt)
    steps[1].done = true; steps[1].ts = now();
    await updateProgress(steps);

    const angles = await generateAngles(brief.body, entity, headlines, env);
    await db.prepare('UPDATE briefs SET angles=? WHERE id=?')
      .bind(JSON.stringify(angles), briefId).run();

    // Step 3: Match journalists from D1 by beat (no external API — curated DB)
    steps[2].done = true; steps[2].ts = now();
    await updateProgress(steps);

    // Pull journalists for each angle's beat, dedup by id
    const idSeen = new Set();
    const allMatched = (await Promise.allSettled(
      angles.map(angle => getJournalistsForBeat(angle.beat, db))
    ))
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(j => {
        if (idSeen.has(j.id)) return false;
        idSeen.add(j.id);
        return true;
      });

    // Filter by 30-day cooldown (cross-brief rate limiting)
    const eligible = filterEligibleJournalists(allMatched);

    if (!eligible.length) {
      await db.prepare("UPDATE briefs SET status='complete' WHERE id=?").bind(briefId).run();
      await message.ack();
      return;
    }

    // Step 4: Pitch drafting (per journalist, parallel)
    steps[3].done = true; steps[3].ts = now();
    await updateProgress(steps);

    // Assign each journalist an angle (round-robin)
    const pitchJobs = eligible.slice(0, 10).map((journalist, i) => {
      const angle = angles[i % angles.length];
      return { journalist, angle };
    });

    const pitchResults = await Promise.allSettled(
      pitchJobs.map(async ({ journalist, angle }) => {
        const article = await getJournalistArticle(journalist.name, journalist.publication);
        const draft = await draftPitch(journalist, entity, angle, brief.body, article.title, article.snippet, env);
        return { journalist, angle, draft };
      })
    );

    // Write successful pitches to D1
    const successful = pitchResults.filter(r => r.status === 'fulfilled').map(r => r.value);
    for (const { journalist, angle, draft } of successful) {
      await db.prepare(
        'INSERT INTO pitches (id, entity_id, journalist_id, brief_id, story_angle, subject, body, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(uid(), brief.entity_id, journalist.id, briefId, angle.angle, draft.subject, draft.body, 'pending', now()).run();
    }

    await db.prepare("UPDATE briefs SET status='complete' WHERE id=?").bind(briefId).run();
    await message.ack();

    // Telegram: notify pitches ready
    const entityRow = await db.prepare('SELECT name FROM entities WHERE id=?').bind(brief.entity_id).first();
    await telegram(
      `🎯 <b>${successful.length} pitches ready</b>\n${entityRow?.name}: "${brief.body.slice(0, 80)}..."\nApprove at publicist.engageengine.ai/queue`,
      env
    );

  } catch (err) {
    await db.prepare("UPDATE briefs SET status='error', progress_log=? WHERE id=?")
      .bind(JSON.stringify([{ step: 'ERROR', msg: String((err && err.message) || err), done: false, ts: now() }]), briefId).run();
    // Do NOT ack — let Cloudflare retry up to max_retries
    throw err;
  }
}

// ============================================================
// HTML PAGES
// ============================================================

const CSS = `
:root {
  --bg: #F5F3EE;
  --surface: #FFFFFF;
  --border: #E2DED5;
  --text: #1C1917;
  --dim: #78716C;
  --accent: #CF6344;
  --green: #16A34A;
  --amber: #D97706;
  --red: #DC2626;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 15px; line-height: 1.5; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.nav { display: flex; align-items: center; gap: 0; border-bottom: 1px solid var(--border); background: var(--surface); padding: 0 24px; }
.nav-brand { font-weight: 700; font-size: 14px; letter-spacing: .5px; color: var(--dim); padding: 16px 20px 16px 0; border-right: 1px solid var(--border); margin-right: 8px; }
.nav a { padding: 18px 16px; font-size: 14px; color: var(--dim); border-bottom: 2px solid transparent; transition: all .15s; }
.nav a:hover { color: var(--text); text-decoration: none; }
.nav a.active { color: var(--accent); border-bottom-color: var(--accent); }
.badge { display: inline-block; background: var(--accent); color: #fff; border-radius: 10px; font-size: 11px; font-weight: 700; padding: 1px 6px; margin-left: 4px; vertical-align: middle; }
.page { max-width: 760px; margin: 0 auto; padding: 40px 24px; }
.page-wide { max-width: 960px; margin: 0 auto; padding: 40px 24px; }
.label { font-size: 12px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; color: var(--dim); }
h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
h2 { font-size: 18px; font-weight: 700; margin-bottom: 16px; }
.muted { color: var(--dim); font-size: 13px; }
textarea { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 15px; font-family: inherit; padding: 16px; resize: vertical; min-height: 140px; outline: none; transition: border-color .15s; }
textarea:focus { border-color: var(--accent); }
select { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 14px; padding: 10px 14px; outline: none; cursor: pointer; width: 100%; max-width: 320px; }
select:focus { border-color: var(--accent); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 24px; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; border: none; transition: all .15s; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { opacity: .88; }
.btn-primary:disabled { opacity: .4; cursor: not-allowed; }
.btn-ghost { background: transparent; color: var(--dim); border: 1px solid var(--border); }
.btn-ghost:hover { color: var(--text); border-color: var(--dim); }
.btn-green { background: var(--green); color: #fff; }
.btn-green:hover { opacity: .88; }
.btn-sm { padding: 8px 16px; font-size: 13px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
.form-group { margin-bottom: 20px; }
.form-group label { display: block; margin-bottom: 8px; font-size: 14px; font-weight: 500; }
.status-line { color: var(--dim); font-size: 13px; margin-top: 6px; }
.progress-bar-wrap { background: var(--border); border-radius: 4px; height: 4px; overflow: hidden; }
.progress-bar { background: var(--accent); height: 100%; border-radius: 4px; transition: width 1s ease; }
.step-list { list-style: none; margin-top: 20px; }
.step-list li { padding: 8px 0; display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--dim); }
.step-list li.done { color: var(--text); }
.step-list li.active { color: var(--accent); }
.step-icon { width: 18px; text-align: center; }
.pitch-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 12px; overflow: hidden; transition: border-color .15s; }
.pitch-card.approved { border-left: 3px solid var(--green); }
.pitch-card.skipped { opacity: .45; }
.pitch-card-header { padding: 16px 20px 12px; }
.pitch-card-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.pitch-journalist { font-weight: 700; font-size: 15px; }
.pitch-pub { color: var(--dim); font-size: 14px; }
.pitch-angle { display: inline-block; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; font-size: 11px; font-weight: 600; letter-spacing: .3px; padding: 2px 8px; color: var(--dim); }
.pitch-personalization { font-size: 12px; color: var(--dim); margin-bottom: 8px; }
.pitch-subject { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
.pitch-body-preview { color: var(--dim); font-size: 13px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.pitch-actions { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--border); background: var(--bg); }
.coverage-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 28px; }
.metric { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.metric-value { font-size: 28px; font-weight: 700; }
.metric-label { font-size: 12px; color: var(--dim); margin-top: 2px; }
.metric-trend { font-size: 12px; color: var(--green); margin-top: 4px; }
.coverage-item { display: flex; align-items: flex-start; gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--border); }
.coverage-item:last-child { border-bottom: none; }
.sentiment-badge { display: inline-flex; align-items: center; gap: 4px; border-radius: 12px; padding: 3px 10px; font-size: 12px; font-weight: 600; }
.sentiment-badge.positive { background: rgba(34,197,94,.15); color: var(--green); }
.sentiment-badge.neutral { background: rgba(120,113,108,.14); color: var(--dim); }
.sentiment-badge.negative { background: rgba(239,68,68,.15); color: var(--red); }
.empty-state { text-align: center; padding: 60px 20px; color: var(--dim); }
.empty-state h3 { font-size: 16px; color: var(--text); margin-bottom: 8px; }
.filter-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
.filter-tabs a { padding: 10px 18px; font-size: 13px; color: var(--dim); border-bottom: 2px solid transparent; }
.filter-tabs a:hover { color: var(--text); text-decoration: none; }
.filter-tabs a.active { color: var(--accent); border-bottom-color: var(--accent); }
.bulk-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.alert { padding: 12px 16px; border-radius: 8px; font-size: 14px; margin-bottom: 20px; }
.alert-error { background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.3); color: var(--red); }
.alert-success { background: rgba(34,197,94,.1); border: 1px solid rgba(34,197,94,.3); color: var(--green); }
@media (max-width: 600px) {
  .coverage-metrics { grid-template-columns: 1fr; }
  .nav { overflow-x: auto; }
  .pitch-card-meta { gap: 6px; }
}
`;

function shell(title, body, activeTab, queueCount = 0) {
  const tabs = [
    { href: '/brief', label: 'Brief', key: 'brief' },
    { href: '/queue', label: `Queue${queueCount ? `<span class="badge">${queueCount}</span>` : ''}`, key: 'queue' },
    { href: '/coverage', label: 'Coverage', key: 'coverage' },
    { href: '/journalists', label: 'Journalists', key: 'journalists' },
    { href: '/discover', label: 'Discover', key: 'discover' },
  ];

  const navLinks = tabs.map(t =>
    `<a href="${t.href}" class="${activeTab === t.key ? 'active' : ''}">${t.label}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Agentic Publicist</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<nav class="nav">
  <span class="nav-brand">PUBLICIST</span>
  ${navLinks}
</nav>
${body}
</body>
</html>`;
}

// ============================================================
// PAGE: /brief
// ============================================================

async function briefPage(req, env) {
  const db = env.DB;
  const url = new URL(req.url);
  const msg = url.searchParams.get('msg');

  // Entities come from D1 — /api/import can create client entities, so the
  // dropdown must not be hardcoded to the three seeded ones.
  const entities = await db.prepare('SELECT id, name FROM entities ORDER BY name').all().then(r => r.results || []);
  const selectedEntity = url.searchParams.get('entity') || (entities.find(e => e.id === 'engageengine') ? 'engageengine' : (entities[0] || {}).id || '');

  // Get last brief for status line
  const lastBrief = await db.prepare(
    'SELECT created_at FROM briefs WHERE entity_id=? ORDER BY created_at DESC LIMIT 1'
  ).bind(selectedEntity).first();

  const lastRun = lastBrief
    ? `Last run: ${relativeTime(lastBrief.created_at)}`
    : 'No briefs submitted yet';

  const msgHtml = msg === 'queued'
    ? '<div class="alert alert-success">Brief queued — pitches will be ready in ~45 seconds.</div>'
    : '';

  const entityOptions = entities.map(e =>
    `<option value="${esc(e.id)}" ${e.id === selectedEntity ? 'selected' : ''}>${esc(e.name)}</option>`
  ).join('');

  const body = `
<div class="page">
  ${msgHtml}
  <div style="margin-bottom:28px">
    <div class="label" style="margin-bottom:10px">Entity</div>
    <select id="entitySelect" onchange="window.location='/brief?entity='+encodeURIComponent(this.value)">
      ${entityOptions}
    </select>
    <div class="status-line" style="margin-top:8px">${lastRun}</div>
  </div>

  <form method="POST" action="/api/generate" id="briefForm">
    <input type="hidden" name="entity_id" value="${esc(selectedEntity)}">
    <div class="form-group">
      <textarea name="body" id="briefBody" placeholder="Paste your announcement brief — what happened, why it matters, who should care" required></textarea>
    </div>
    <div id="interviewBox" style="display:none;margin-bottom:20px">
      <div class="label" style="margin-bottom:10px">Strategic Interview — answer what you can, skip what you can't</div>
      <div id="interviewQs"></div>
    </div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <button type="submit" class="btn btn-primary" id="submitBtn">Generate Pitches</button>
      <button type="button" class="btn btn-ghost" id="interviewBtn">Interview Me First</button>
      <span class="muted">~45 seconds</span>
    </div>
  </form>
</div>
<script>
var interviewDone = false;
document.getElementById('interviewBtn').addEventListener('click', function() {
  var btn = this;
  var body = document.getElementById('briefBody').value.trim();
  if (!body) { alert('Paste your announcement first — the interview digs into it.'); return; }
  btn.disabled = true; btn.textContent = 'Thinking…';
  fetch('/api/interview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_id: document.querySelector('input[name=entity_id]').value, body: body })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (!d.ok || !d.questions || !d.questions.length) { btn.textContent = 'Interview unavailable'; return; }
    var box = document.getElementById('interviewQs');
    box.innerHTML = '';
    d.questions.forEach(function(q, i) {
      var wrap = document.createElement('div');
      wrap.className = 'form-group';
      var lab = document.createElement('label');
      lab.textContent = q;
      var ta = document.createElement('textarea');
      ta.style.minHeight = '60px';
      ta.setAttribute('data-iq', q);
      wrap.appendChild(lab); wrap.appendChild(ta); box.appendChild(wrap);
    });
    document.getElementById('interviewBox').style.display = 'block';
    btn.style.display = 'none';
    interviewDone = true;
    document.getElementById('submitBtn').textContent = 'Generate from Interview';
  }).catch(function() { btn.disabled = false; btn.textContent = 'Interview Me First'; });
});
document.getElementById('briefForm').addEventListener('submit', function() {
  if (interviewDone) {
    var extra = '';
    var tas = document.querySelectorAll('#interviewQs textarea');
    for (var i = 0; i < tas.length; i++) {
      var a = tas[i].value.trim();
      if (a) extra += '\\nQ: ' + tas[i].getAttribute('data-iq') + '\\nA: ' + a;
    }
    if (extra) {
      var bb = document.getElementById('briefBody');
      bb.value = bb.value + '\\n\\n--- STRATEGIC INTERVIEW ---' + extra;
    }
  }
  document.getElementById('submitBtn').disabled = true;
  document.getElementById('submitBtn').textContent = 'Queuing…';
});
</script>`;

  const queueCount = await pendingPitchCount(db);
  return new Response(shell('Brief', body, 'brief', queueCount), {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

// ============================================================
// PAGE: /queue
// ============================================================

async function queuePage(req, env) {
  const db = env.DB;
  const url = new URL(req.url);
  const msg = url.searchParams.get('msg');

  const pitches = await db.prepare(`
    SELECT p.*, j.name as journalist_name, j.email as journalist_email,
           j.publication, e.name as entity_name,
           b.body as brief_body
    FROM pitches p
    JOIN journalists j ON j.id = p.journalist_id
    JOIN entities e ON e.id = p.entity_id
    LEFT JOIN briefs b ON b.id = p.brief_id
    WHERE p.status IN ('pending','approved','skipped')
    ORDER BY p.created_at DESC
    LIMIT 50
  `).all().then(r => r.results || []);

  const pending = pitches.filter(p => p.status === 'pending');
  const msgHtml = msg === 'sent'
    ? '<div class="alert alert-success">Pitches sent successfully.</div>'
    : msg === 'approved'
    ? '<div class="alert alert-success">Pitch approved.</div>'
    : '';

  const cards = pitches.length ? pitches.map(p => {
    const cardClass = p.status === 'approved' ? 'approved' : p.status === 'skipped' ? 'skipped' : '';
    const briefExcerpt = p.brief_body ? p.brief_body.slice(0, 60) : '';
    return `
<div class="pitch-card ${cardClass}" id="pitch-${p.id}">
  <div class="pitch-card-header">
    <div class="pitch-card-meta">
      <span class="pitch-journalist">${esc(p.journalist_name)}</span>
      <span class="pitch-pub">${esc(p.publication)}</span>
      ${p.story_angle ? `<span class="pitch-angle">${esc(p.story_angle.slice(0, 40))}</span>` : ''}
    </div>
    ${briefExcerpt ? `<div class="pitch-personalization">Brief: "${esc(briefExcerpt)}…"</div>` : ''}
    <div class="pitch-subject">${esc(p.subject || '')}</div>
    <div class="pitch-body-preview">${esc(p.body || '')}</div>
  </div>
  <div class="pitch-actions">
    ${p.status === 'pending' ? `
      <button class="btn btn-green btn-sm" onclick="approvePitch('${p.id}')" aria-label="Approve pitch">APPROVE</button>
      <button class="btn btn-ghost btn-sm" onclick="skipPitch('${p.id}')" aria-label="Skip pitch">SKIP</button>
    ` : p.status === 'approved' ? `
      <span style="color:var(--green);font-size:13px;font-weight:600">✓ Approved</span>
      <button class="btn btn-ghost btn-sm" onclick="skipPitch('${p.id}')">Undo</button>
    ` : `
      <span style="color:var(--dim);font-size:13px">Skipped</span>
    `}
  </div>
</div>`;
  }).join('') : `
<div class="empty-state">
  <h3>No pitches ready yet</h3>
  <p>Submit a brief to generate your first batch.</p>
  <a href="/brief" style="display:inline-block;margin-top:16px;color:var(--accent)">Go to Brief →</a>
</div>`;

  const approvedCount = pitches.filter(p => p.status === 'approved').length;
  const bulkBar = pitches.length ? `
<div class="bulk-bar">
  <div>
    <h2 style="margin:0">${pending.length} pitches pending${approvedCount ? ` · ${approvedCount} approved` : ''}</h2>
  </div>
  ${approvedCount ? `<button class="btn btn-green btn-sm" onclick="sendApproved()">Send ${approvedCount} Approved</button>` : ''}
</div>` : '';

  const body = `
<div class="page-wide">
  ${msgHtml}
  ${bulkBar}
  ${cards}
</div>
<script>
async function approvePitch(id) {
  const card = document.getElementById('pitch-' + id);
  const res = await fetch('/api/pitches/' + id + '/approve', { method: 'POST' });
  if (res.ok) { location.reload(); }
}
async function skipPitch(id) {
  const card = document.getElementById('pitch-' + id);
  const res = await fetch('/api/pitches/' + id + '/skip', { method: 'POST' });
  if (res.ok) { location.reload(); }
}
async function sendApproved() {
  if (!confirm('Send all approved pitches now?')) return;
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Sending…';
  const res = await fetch('/api/send', { method: 'POST' });
  if (res.ok) { location.href = '/queue?msg=sent'; }
  else { btn.disabled = false; btn.textContent = 'Send Approved'; alert('Send failed. Check RESEND_API_KEY.'); }
}
</script>`;

  const queueCount = await pendingPitchCount(db);
  return new Response(shell('Queue', body, 'queue', queueCount), {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

// ============================================================
// PAGE: /coverage
// ============================================================

async function coveragePage(req, env) {
  const db = env.DB;
  const url = new URL(req.url);
  const filter = url.searchParams.get('filter') || 'all';

  const thirtyDaysAgo = Date.now() - THIRTY_DAYS_MS;

  let query = `SELECT c.*, e.name as entity_name FROM coverage c
    JOIN entities e ON e.id = c.entity_id
    WHERE c.created_at > ?`;
  const params = [thirtyDaysAgo];
  if (filter !== 'all') { query += ' AND c.sentiment=?'; params.push(filter); }
  query += ' ORDER BY c.published_at DESC LIMIT 50';

  const items = await db.prepare(query).bind(...params).all().then(r => r.results || []);

  const allItems = await db.prepare(
    'SELECT sentiment FROM coverage WHERE created_at > ?'
  ).bind(thirtyDaysAgo).all().then(r => r.results || []);

  const totalMentions = allItems.length;
  const positive = allItems.filter(i => i.sentiment === 'positive').length;
  const pubs = new Set(items.map(i => i.publication)).size;

  const coverageItems = items.length ? items.map(i => `
<div class="coverage-item">
  <div style="flex:1">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
      <span style="font-weight:600;font-size:13px">${esc(i.publication || '')}</span>
      <span class="muted">${formatDate(i.published_at)}</span>
      <span class="sentiment-badge ${i.sentiment}" aria-label="${i.sentiment} coverage">${i.sentiment}</span>
    </div>
    <div><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.headline || 'View article')}</a></div>
    <div class="muted" style="font-size:12px;margin-top:2px">${esc(i.entity_name)}</div>
  </div>
</div>`).join('') : `
<div class="empty-state">
  <h3>No coverage found</h3>
  <p>Coverage monitoring checks Google News daily at 7am.<br>Trigger a manual check below.</p>
  <button class="btn btn-ghost btn-sm" style="margin-top:16px" onclick="pollCoverage()">Check Now</button>
</div>`;

  const filterTabs = ['all', 'positive', 'neutral', 'negative'].map(f =>
    `<a href="/coverage?filter=${f}" class="${filter === f ? 'active' : ''}">${f.charAt(0).toUpperCase() + f.slice(1)}</a>`
  ).join('');

  const body = `
<div class="page-wide">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
    <h2 style="margin:0">Coverage</h2>
    <button class="btn btn-ghost btn-sm" onclick="pollCoverage()">Check Now</button>
  </div>
  <div class="coverage-metrics">
    <div class="metric">
      <div class="metric-value">${totalMentions}</div>
      <div class="metric-label">Mentions This Month</div>
    </div>
    <div class="metric">
      <div class="metric-value">${positive}</div>
      <div class="metric-label">Positive</div>
    </div>
    <div class="metric">
      <div class="metric-value">${pubs}</div>
      <div class="metric-label">Publications</div>
    </div>
  </div>
  <div class="filter-tabs">${filterTabs}</div>
  ${coverageItems}
</div>
<script>
async function pollCoverage() {
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Checking…';
  const res = await fetch('/api/coverage/poll', { method: 'POST' });
  if (res.ok) { setTimeout(() => location.reload(), 3000); }
  else { btn.disabled = false; btn.textContent = 'Check Now'; }
}
</script>`;

  const queueCount = await pendingPitchCount(db);
  return new Response(shell('Coverage', body, 'coverage', queueCount), {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

// ============================================================
// PAGE: /progress/:briefId
// ============================================================

async function progressPage(briefId, env) {
  const body = `
<div class="page">
  <div class="card" style="max-width:480px;margin:0 auto;text-align:center;padding:40px">
    <h2 style="margin-bottom:20px">Generating Pitches</h2>
    <div class="progress-bar-wrap" style="margin-bottom:24px">
      <div class="progress-bar" id="bar" style="width:10%"></div>
    </div>
    <ul class="step-list" id="steps" style="text-align:left;max-width:320px;margin:0 auto"></ul>
    <div class="muted" style="margin-top:24px">Usually takes 30–45 seconds</div>
  </div>
</div>
<script>
const briefId = ${JSON.stringify(briefId)};
let pct = 10;

async function poll() {
  const res = await fetch('/api/briefs/' + briefId + '/status');
  if (!res.ok) { setTimeout(poll, 3000); return; }
  const data = await res.json();

  const steps = data.progress_log || [];
  const stepEl = document.getElementById('steps');
  stepEl.innerHTML = steps.map((s, i) => {
    const cls = s.done ? 'done' : (i === steps.findIndex(x => !x.done) ? 'active' : '');
    const icon = s.done ? '✓' : (cls === 'active' ? '→' : '·');
    return '<li class="' + cls + '"><span class="step-icon">' + icon + '</span>' + s.step + '</li>';
  }).join('');

  const done = steps.filter(s => s.done).length;
  pct = Math.max(pct, Math.round((done / Math.max(steps.length, 1)) * 85) + 10);
  document.getElementById('bar').style.width = pct + '%';

  if (data.status === 'complete') {
    document.getElementById('bar').style.width = '100%';
    setTimeout(() => { window.location.href = '/queue'; }, 800);
    return;
  }
  if (data.status === 'error') {
    document.getElementById('bar').style.background = 'var(--red)';
    stepEl.innerHTML += '<li style="color:var(--red)">Pipeline error — <a href="/brief">try again</a></li>';
    return;
  }
  setTimeout(poll, 3000);
}
poll();
</script>`;

  return new Response(shell('Generating…', body, 'brief'), {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

// ============================================================
// PAGE: /journalists
// ============================================================

async function journalistsPage(req, env) {
  const db = env.DB;
  const url = new URL(req.url);
  const msg = url.searchParams.get('msg');

  const journalists = await db.prepare(
    'SELECT * FROM journalists ORDER BY publication, name LIMIT 200'
  ).all().then(r => r.results || []);

  const msgHtml = msg === 'added'
    ? '<div class="alert alert-success">Journalist added.</div>'
    : msg === 'deleted'
    ? '<div class="alert alert-success">Journalist removed.</div>'
    : '';

  const beatOptions = KNOWN_BEATS.map(b =>
    `<option value="${b}">${b}</option>`
  ).join('');

  const rows = journalists.length ? journalists.map(j => {
    const beats = JSON.parse(j.beat_keywords || '[]');
    const lastContact = j.last_contacted_at ? relativeTime(j.last_contacted_at) : 'Never';
    const ot = j.outlet_type || 'journalist';
    return `
<tr>
  <td style="font-weight:600">${esc(j.name)}${ot !== 'journalist' ? ` <span class="pitch-angle" style="margin-left:6px">${esc(ot)}</span>` : ''}</td>
  <td>${esc(j.publication)}</td>
  <td>${esc(j.email)}</td>
  <td>${beats.map(b => `<span class="pitch-angle" style="margin-right:4px">${esc(b)}</span>`).join('')}</td>
  <td class="muted">${lastContact}</td>
  <td>
    <button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:var(--red)"
      onclick="deleteJournalist('${j.id}')">Remove</button>
  </td>
</tr>`;
  }).join('') : `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--dim)">No journalists yet. Add your first one below.</td></tr>`;

  const body = `
<div class="page-wide">
  ${msgHtml}
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
    <div>
      <h2 style="margin:0">Journalist Database</h2>
      <p class="muted" style="margin-top:4px">${journalists.length} journalist${journalists.length !== 1 ? 's' : ''} · curated, no external API</p>
    </div>
  </div>

  <div class="card" style="margin-bottom:28px">
    <h3 style="margin-bottom:16px;font-size:15px">Add Journalist</h3>
    <form method="POST" action="/api/journalists" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="form-group" style="margin:0">
        <label>Name</label>
        <input type="text" name="name" required placeholder="Jane Smith"
          style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px;padding:9px 12px;outline:none">
      </div>
      <div class="form-group" style="margin:0">
        <label>Email</label>
        <input type="email" name="email" required placeholder="jane@techcrunch.com"
          style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px;padding:9px 12px;outline:none">
      </div>
      <div class="form-group" style="margin:0">
        <label>Publication</label>
        <input type="text" name="publication" required placeholder="TechCrunch"
          style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px;padding:9px 12px;outline:none">
      </div>
      <div class="form-group" style="margin:0">
        <label>Beats (hold ⌘/Ctrl to select multiple)</label>
        <select name="beats" multiple size="3"
          style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;padding:6px 10px;outline:none">
          ${beatOptions}
        </select>
      </div>
      <div class="form-group" style="margin:0">
        <label>Outlet type</label>
        <select name="outlet_type"
          style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;padding:9px 12px;outline:none">
          <option value="journalist" selected>Journalist</option>
          <option value="blog">Blog</option>
          <option value="podcast">Podcast</option>
        </select>
      </div>
      <div style="grid-column:1/-1">
        <button type="submit" class="btn btn-primary btn-sm">Add Journalist</button>
      </div>
    </form>
  </div>

  <table style="width:100%;border-collapse:collapse">
    <thead>
      <tr style="border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:8px 0;font-size:12px;color:var(--dim);font-weight:600">NAME</th>
        <th style="text-align:left;padding:8px 0;font-size:12px;color:var(--dim);font-weight:600">PUBLICATION</th>
        <th style="text-align:left;padding:8px 0;font-size:12px;color:var(--dim);font-weight:600">EMAIL</th>
        <th style="text-align:left;padding:8px 0;font-size:12px;color:var(--dim);font-weight:600">BEATS</th>
        <th style="text-align:left;padding:8px 0;font-size:12px;color:var(--dim);font-weight:600">LAST CONTACT</th>
        <th></th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>
<script>
async function deleteJournalist(id) {
  if (!confirm('Remove this journalist?')) return;
  const res = await fetch('/api/journalists/' + id, { method: 'DELETE' });
  if (res.ok) location.href = '/journalists?msg=deleted';
}
</script>`;

  const queueCount = await pendingPitchCount(db);
  return new Response(shell('Journalists', body, 'journalists', queueCount), {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

// ============================================================
// API HANDLERS
// ============================================================

async function handleGenerate(req, env) {
  const form = await req.formData();
  const entityId = form.get('entity_id');
  const body = (form.get('body') || '').trim();

  if (!entityId || !body) {
    return redirect(req, '/brief?msg=error', 303);
  }

  const entity = await env.DB.prepare('SELECT id FROM entities WHERE id=?').bind(entityId).first();
  if (!entity) return new Response('Unknown entity', { status: 400 });

  const briefId = uid();
  await env.DB.prepare(
    'INSERT INTO briefs (id, entity_id, body, status, progress_log, created_at) VALUES (?,?,?,?,?,?)'
  ).bind(briefId, entityId, body, 'pending', '[]', now()).run();

  // Enqueue for async processing
  try {
    await env.PIPELINE_QUEUE.send({ briefId });
  } catch (err) {
    await env.DB.prepare("UPDATE briefs SET status='error' WHERE id=?").bind(briefId).run();
    return new Response(JSON.stringify({ error: 'Service unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return redirect(req, `/progress/${briefId}`, 303);
}

async function handleBriefStatus(briefId, env) {
  const brief = await env.DB.prepare('SELECT status, progress_log FROM briefs WHERE id=?').bind(briefId).first();
  if (!brief) return new Response('Not found', { status: 404 });
  return json({ status: brief.status, progress_log: JSON.parse(brief.progress_log || '[]') });
}

async function handlePitchAction(pitchId, action, env) {
  const col = action === 'approve' ? 'approved_at' : null;
  const status = action === 'approve' ? 'approved' : 'skipped';

  if (col) {
    await env.DB.prepare(`UPDATE pitches SET status=?, ${col}=? WHERE id=?`)
      .bind(status, now(), pitchId).run();
  } else {
    await env.DB.prepare('UPDATE pitches SET status=? WHERE id=?').bind(status, pitchId).run();
  }
  return json({ ok: true });
}

async function handleSend(env) {
  const approved = await env.DB.prepare(`
    SELECT p.*, j.name as journalist_name, j.email as journalist_email,
           j.id as journalist_db_id, e.name as entity_name, e.type as entity_type
    FROM pitches p
    JOIN journalists j ON j.id = p.journalist_id
    JOIN entities e ON e.id = p.entity_id
    WHERE p.status='approved'
    LIMIT 50
  `).all().then(r => r.results || []);

  if (!approved.length) return json({ sent: 0 });

  let sent = 0;
  for (const pitch of approved) {
    try {
      const emailId = await sendPitchEmail(
        { subject: pitch.subject, body: pitch.body },
        { email: pitch.journalist_email, name: pitch.journalist_name },
        { name: pitch.entity_name },
        env
      );
      await env.DB.prepare("UPDATE pitches SET status='sent', sent_at=?, resend_email_id=? WHERE id=?")
        .bind(now(), emailId, pitch.id).run();
      // Update journalist last_contacted_at at SEND time (not approval)
      await env.DB.prepare('UPDATE journalists SET last_contacted_at=? WHERE id=?')
        .bind(now(), pitch.journalist_db_id).run();
      sent++;
    } catch { /* log, continue with others */ }
  }

  await telegram(`📨 ${sent} pitch${sent !== 1 ? 'es' : ''} sent`, env);
  return json({ sent });
}

async function handleAddJournalist(req, env) {
  const form = await req.formData();
  const name = (form.get('name') || '').trim();
  const email = (form.get('email') || '').trim().toLowerCase();
  const publication = (form.get('publication') || '').trim();
  const beats = form.getAll('beats').filter(b => KNOWN_BEATS.includes(b));
  const outletType = ['journalist', 'blog', 'podcast'].includes(form.get('outlet_type')) ? form.get('outlet_type') : 'journalist';

  if (!name || !email || !publication) {
    return redirect(req, '/journalists?msg=error', 303);
  }

  await env.DB.prepare(
    'INSERT OR IGNORE INTO journalists (id, name, email, publication, beat_keywords, last_contacted_at, outlet_type) VALUES (?,?,?,?,?,?,?)'
  ).bind(uid(), name, email, publication, JSON.stringify(beats), null, outletType).run();

  return redirect(req, '/journalists?msg=added', 303);
}

async function handleDeleteJournalist(journalistId, env) {
  await env.DB.prepare('DELETE FROM journalists WHERE id=?').bind(journalistId).run();
  return json({ ok: true });
}

async function handleResendWebhook(req, env) {
  // Validate Svix signature (Resend webhook security)
  const webhookSecret = env.RESEND_WEBHOOK_SECRET;
  if (webhookSecret) {
    const svixId = req.headers.get('svix-id');
    const svixTs = req.headers.get('svix-timestamp');
    const svixSig = req.headers.get('svix-signature');
    if (!svixId || !svixTs || !svixSig) {
      return new Response('Missing webhook headers', { status: 400 });
    }
    // Simple timestamp validation (within 5 minutes)
    if (Math.abs(Date.now() / 1000 - parseInt(svixTs)) > 300) {
      return new Response('Webhook timestamp too old', { status: 400 });
    }
    // Full signature validation would use HMAC-SHA256; simplified here
    // In production: validate svixSig using the Svix library or manual HMAC
  }

  const event = await req.json();
  if (!event.type || !event.data) return new Response('OK');

  const emailId = event.data.email_id;
  if (!emailId) return new Response('OK');

  if (event.type === 'email.bounced' || event.type === 'email.complained') {
    await env.DB.prepare("UPDATE pitches SET status='bounced' WHERE resend_email_id=?")
      .bind(emailId).run();
  }

  return new Response('OK');
}

async function handleCoveragePoll(env) {
  const entities = await env.DB.prepare('SELECT * FROM entities').all().then(r => r.results || []);
  let added = 0;

  for (const entity of entities) {
    const headlines = await getTopHeadlines(`"${entity.name}"`);
    for (const headline of headlines) {
      // Use a placeholder URL constructed from entity + headline
      const fakeUrl = `https://news.google.com/search?q=${encodeURIComponent(entity.name + ' ' + headline)}`;
      const hash = await hashUrl(fakeUrl);

      const exists = await env.DB.prepare('SELECT id FROM coverage WHERE hash=?').bind(hash).first();
      if (exists) continue;

      // Score sentiment
      const sentiment = env.ANTHROPIC_API_KEY
        ? await scoreSentiment(headline, '', entity.name, env)
        : 'neutral';

      await env.DB.prepare(
        'INSERT INTO coverage (id, entity_id, url, headline, publication, published_at, sentiment, hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(uid(), entity.id, fakeUrl, headline, 'Google News', now(), sentiment, hash, now()).run();
      added++;
    }
  }

  if (added > 0) {
    await telegram(`📰 ${added} new coverage mention${added !== 1 ? 's' : ''} found`, env);
  }

  return json({ added });
}

// ============================================================
// HELPERS
// ============================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function redirect(req, path, status = 302) {
  const base = new URL(req.url).origin;
  return Response.redirect(base + path, status);
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relativeTime(ts) {
  if (!ts) return 'never';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function pendingPitchCount(db) {
  const row = await db.prepare("SELECT COUNT(*) as n FROM pitches WHERE status='pending'").first();
  return row?.n || 0;
}

// ===== EngageEngine shared password-session gate (canonical) =====
async function eeSign(env, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SIGNING_KEY || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function eeIssue(env) { const exp = Date.now() + 30 * 864e5; return exp + "." + await eeSign(env, "ee:" + exp); }
async function eeValid(env, tok) {
  if (!tok) return false;
  const i = tok.lastIndexOf(".");
  if (i < 1) return false;
  const exp = tok.slice(0, i), sig = tok.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return sig === await eeSign(env, "ee:" + exp);
}
function eeCookie(req, name) {
  const h = req.headers.get("Cookie") || "";
  const m = h.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + "="));
  return m ? m.slice(name.length + 1) : null;
}
function eeLoginPage(ret, err) {
  const body = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>EngageEngine — Sign In</title><style>body{font-family:'DM Sans',system-ui,sans-serif;background:#F5F3EE;color:#1C1917;display:grid;place-items:center;min-height:100vh;margin:0}form{background:#fff;border:1px solid #E2DED5;border-radius:12px;padding:32px;width:320px;box-shadow:0 2px 12px rgba(0,0,0,.05)}h1{font-size:16px;margin:0 0 4px;letter-spacing:.04em}p{color:#78716C;font-size:13px;margin:0 0 20px}input{width:100%;padding:10px;border:1px solid #E2DED5;border-radius:8px;font-size:14px;margin-bottom:12px;box-sizing:border-box}button{width:100%;padding:10px;background:#CF6344;color:#fff;border:0;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer}.err{color:#DC2626;font-size:12px;margin-bottom:10px}</style><form method=POST action="/ee-login?return=${encodeURIComponent(ret)}"><h1>ENGAGE|ENGINE</h1><p>Enter the team password to continue.</p>${err ? '<div class=err>' + err + '</div>' : ''}<input type=password name=password autofocus placeholder="Password"><button>Sign in</button></form>`;
  return new Response(body, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
async function eeGate(request, env, publicRes) {
  const url = new URL(request.url);
  if (url.pathname === "/ee-login" && request.method === "POST") {
    const form = await request.formData();
    const ret = url.searchParams.get("return") || "/";
    if ((form.get("password") || "") === env.APP_PASSWORD) {
      const tok = await eeIssue(env);
      return new Response(null, { status: 302, headers: { "Location": ret, "Set-Cookie": `ee_session=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` } });
    }
    return eeLoginPage(ret, "Incorrect password");
  }
  if ((publicRes || []).some((re) => re.test(url.pathname))) return null;
  if (await eeValid(env, eeCookie(request, "ee_session"))) return null;
  const accept = request.headers.get("Accept") || "";
  if (accept.includes("text/html")) return eeLoginPage(url.pathname + url.search, "");
  return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
}

// ============================================================
// Skill ingest — persist a fully-formed plan produced by the
// /publicist skill so it lands in D1 and shows in /queue.
// Unlike /api/generate (which re-runs the worker pipeline), this
// stores the skill's OWN plan verbatim and supports any client
// entity, not just the three seeded ones.
// Auth: Authorization: Bearer <INGEST_TOKEN>
// ============================================================
async function handleImportPlan(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let payload;
  try { payload = await req.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const ent = payload.entity || {};
  const brief = payload.brief || {};
  const pitches = Array.isArray(payload.pitches) ? payload.pitches : [];

  if (!ent.name || !brief.body) {
    return json({ error: 'entity.name and brief.body are required' }, 400);
  }

  const db = env.DB;

  // 1) Upsert entity — by explicit id, else by name (case-insensitive).
  let entityRow = null;
  if (ent.id) entityRow = await db.prepare('SELECT id FROM entities WHERE id=?').bind(ent.id).first();
  if (!entityRow) entityRow = await db.prepare('SELECT id FROM entities WHERE lower(name)=lower(?)').bind(ent.name).first();
  let entityId;
  if (entityRow) {
    entityId = entityRow.id;
  } else {
    entityId = ent.id || uid();
    await db.prepare(
      'INSERT INTO entities (id, name, type, bio_short, bio_long, expertise_keywords) VALUES (?,?,?,?,?,?)'
    ).bind(
      entityId, ent.name, ent.type || 'client',
      ent.bio_short || null, ent.bio_long || null,
      ent.expertise_keywords ? JSON.stringify(ent.expertise_keywords) : null
    ).run();
  }

  // 2) Insert the brief — already complete; the skill produced the plan.
  const briefId = uid();
  const angles = brief.angles ? JSON.stringify(brief.angles) : null;
  const progressLog = JSON.stringify([{ step: 'Imported from /publicist skill', done: true, ts: now() }]);
  await db.prepare(
    'INSERT INTO briefs (id, entity_id, body, angles, status, progress_log, created_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(briefId, entityId, brief.body, angles, 'complete', progressLog, now()).run();

  // 3) Upsert journalists + insert pitches so they render in /queue.
  let pitchCount = 0;
  for (const p of pitches) {
    const jr = p.journalist || {};
    if (!jr.name) continue;
    let jrow = null;
    if (jr.email) jrow = await db.prepare('SELECT id FROM journalists WHERE lower(email)=lower(?)').bind(jr.email).first();
    if (!jrow) jrow = await db.prepare(
      "SELECT id FROM journalists WHERE lower(name)=lower(?) AND lower(coalesce(publication,''))=lower(?)"
    ).bind(jr.name, jr.publication || '').first();
    let journalistId;
    if (jrow) {
      journalistId = jrow.id;
    } else {
      journalistId = uid();
      await db.prepare(
        'INSERT INTO journalists (id, name, email, publication, beat_keywords, outlet_type) VALUES (?,?,?,?,?,?)'
      ).bind(
        journalistId, jr.name, jr.email || null, jr.publication || null,
        jr.beat_keywords ? JSON.stringify(jr.beat_keywords) : null,
        ['journalist', 'blog', 'podcast'].includes(jr.outlet_type) ? jr.outlet_type : 'journalist'
      ).run();
    }
    await db.prepare(
      'INSERT INTO pitches (id, entity_id, journalist_id, brief_id, story_angle, subject, body, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(
      uid(), entityId, journalistId, briefId,
      p.story_angle || null, p.subject || null, p.body || null, 'pending', now()
    ).run();
    pitchCount++;
  }

  const origin = new URL(req.url).origin;
  return json({ ok: true, entityId, briefId, pitchCount, queueUrl: `${origin}/queue` });
}

// ============================================================
// Roster read — lets the /publicist skill pull the real journalist
// DB before writing pitches, so it targets actual named reporters
// (like the A4A run) instead of inventing them.
// Auth: Authorization: Bearer <INGEST_TOKEN>
// ============================================================
async function handleRoster(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const typeFilter = new URL(req.url).searchParams.get('type'); // journalist | blog | podcast
  const rows = typeFilter
    ? await env.DB.prepare(
        "SELECT name, email, publication, beat_keywords, outlet_type FROM journalists WHERE coalesce(outlet_type,'journalist')=? ORDER BY publication, name"
      ).bind(typeFilter).all().then(r => r.results || [])
    : await env.DB.prepare(
        'SELECT name, email, publication, beat_keywords, outlet_type FROM journalists ORDER BY publication, name'
      ).all().then(r => r.results || []);
  const journalists = rows.map(j => ({
    name: j.name,
    email: j.email || null,
    publication: j.publication,
    outlet_type: j.outlet_type || 'journalist',
    beats: (() => { try { return JSON.parse(j.beat_keywords || '[]'); } catch { return []; } })(),
  }));
  return json({ ok: true, count: journalists.length, journalists });
}

// ============================================================
// Interview-first brief capture (borrowed from Pressmaster's
// interview-first pattern, run through OUR persona). Given a raw
// announcement, returns 4-5 strategic-interrogation questions that
// dig for the protagonist, the proof point, the why-now, and the
// stakes — the exact probing that surfaced Cooper Rust and the
// $1,500→300-kids proof in the A4A run. Answers get folded into
// the brief body before /api/generate.
// Session-gated (called by the logged-in /brief page).
// ============================================================
async function handleInterview(req, env) {
  let payload;
  try { payload = await req.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }
  const briefBody = (payload.body || '').trim();
  if (!briefBody) return json({ error: 'body is required' }, 400);

  const entity = payload.entity_id
    ? await env.DB.prepare('SELECT * FROM entities WHERE id=?').bind(payload.entity_id).first()
    : null;

  const system = `${PUBLICIST_PERSONA}

Your current task: strategic interrogation. A raw announcement follows. Do NOT write angles or pitches. Instead, ask the 4-5 questions whose answers would most upgrade this story — hunting specifically for:
- the human PROTAGONIST (who is this really about?)
- the concrete PROOF POINT (a real number, stake, or outcome)
- the WHY-NOW / timing hook
- the tension, risk, or blind spot in the current framing
Each question must be specific to THIS announcement, not generic PR intake. If the announcement already answers something, don't ask it.
Return ONLY a raw JSON array of question strings — no markdown fences, no preamble.`;

  const user = `${entity ? `Entity: ${entity.name} (${entity.type}). Bio: ${entity.bio_short || entity.bio_long || ''}\n` : ''}Announcement:
${briefBody}

Return: ["question 1", "question 2", ...]`;

  const text = await callClaude([{ role: 'user', content: user }], system, env, { cacheSystem: true, maxTokens: 800 });
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return json({ error: 'Could not generate questions' }, 502);
  let questions;
  try { questions = JSON.parse(match[0]).filter(q => typeof q === 'string').slice(0, 5); }
  catch { return json({ error: 'Could not parse questions' }, 502); }
  return json({ ok: true, questions });
}

// ============================================================
// Outlet discovery — search-grounded sourcing of real podcasts /
// blogs / journalists for a topic + market, the way the 86 SC
// journalists were sourced. Runs in the queue consumer (long wall
// time), uses the Anthropic server-side web_search tool so every
// candidate is grounded in a real page, and stages candidates for
// human review before anything touches the roster.
// ============================================================

// Claude call with server-side web search + web fetch. MUST stream:
// a non-streaming request with several searches exceeds the ~100s
// HTTP edge timeout and dies with a 524. We accumulate SSE events
// back into content blocks so the pause_turn resume loop still works,
// then concatenate ALL text blocks (search responses interleave text
// with web_search_tool_result blocks).
async function streamClaudeOnce(body, env) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err.slice(0, 300)}`);
  }
  const content = [];
  const inputBuf = {}; // index -> accumulated partial_json
  let stopReason = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete tail
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let ev;
      try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      if (ev.type === 'content_block_start') {
        content[ev.index] = ev.content_block;
        if (ev.content_block && ev.content_block.type === 'text') content[ev.index] = { ...ev.content_block, text: ev.content_block.text || '' };
      } else if (ev.type === 'content_block_delta') {
        const blk = content[ev.index];
        if (!blk) continue;
        if (ev.delta.type === 'text_delta') blk.text = (blk.text || '') + ev.delta.text;
        else if (ev.delta.type === 'input_json_delta') inputBuf[ev.index] = (inputBuf[ev.index] || '') + ev.delta.partial_json;
        else if (ev.delta.type === 'citations_delta') { /* ignore */ }
      } else if (ev.type === 'content_block_stop') {
        if (inputBuf[ev.index] !== undefined && content[ev.index]) {
          try { content[ev.index].input = JSON.parse(inputBuf[ev.index] || '{}'); } catch { /* keep as-is */ }
          delete inputBuf[ev.index];
        }
      } else if (ev.type === 'message_delta') {
        if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      }
    }
  }
  return { content: content.filter(Boolean), stop_reason: stopReason };
}

async function callClaudeSearch(userPrompt, systemText, env, maxTokens = 4000) {
  let messages = [{ role: 'user', content: userPrompt }];
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 6 },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4 },
  ];
  for (let turn = 0; turn < 6; turn++) {
    const data = await streamClaudeOnce({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      system: systemText,
      tools,
      messages,
    }, env);
    if (data.stop_reason === 'pause_turn') {
      // Server-side tool loop paused — append assistant turn and resume.
      messages = [...messages, { role: 'assistant', content: data.content }];
      continue;
    }
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  throw new Error('Search loop did not complete after 6 turns');
}

async function processDiscovery(message, env) {
  const { discoveryId } = message.body;
  const db = env.DB;
  const run = await db.prepare('SELECT * FROM discovery_runs WHERE id=?').bind(discoveryId).first();
  if (!run) { await message.ack(); return; }
  if (run.status === 'complete') { await message.ack(); return; }
  await db.prepare("UPDATE discovery_runs SET status='processing' WHERE id=?").bind(discoveryId).run();

  const outletLabel = run.outlet_type === 'journalist' ? 'journalists / reporters'
    : run.outlet_type === 'blog' ? 'blogs (with named authors/editors)'
    : 'podcasts (with named hosts)';

  const system = `${PUBLICIST_PERSONA}

Your current task: media-outlet DISCOVERY, not pitching. Using web search, find REAL, currently-active ${outletLabel} relevant to the topic and market below. This roster will be used for actual outreach, so accuracy beats volume.

Hard rules:
- ONLY report outlets you actually verified exist via your search/fetch results. NEVER invent a show, blog, publication, host, or email. A wrong contact poisons the roster.
- For each: find the host/author/reporter NAME, the outlet name, its URL, and the best CONTACT PATH (an email if one is published, else the contact/pitch page URL).
- Prefer outlets that actively accept guests/pitches and have published recently (within ~6 months).
- Assign 1-3 beats from exactly this list: marketing-tech, home-services, ai-automation, flooring-industry, small-business, digital-marketing, construction, sc-local, local-business.
- 5-10 strong candidates beat 20 weak ones.
- Return ONLY a raw JSON array, no markdown fences, in this shape:
[{"name":"host or author name","publication":"outlet name","url":"https://...","email":"...or null","contact_url":"...or null","beats":["small-business"],"why_fit":"1-2 sentences: why this outlet fits the topic + evidence it's active"}]`;

  const user = `Topic / who we're pitching: ${run.query}
Market: ${run.market || 'United States (no specific city)'}
Outlet type: ${run.outlet_type}`;

  try {
    const text = await callClaudeSearch(user, system, env, 4000);
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in discovery output');
    const candidates = JSON.parse(match[0])
      .filter(c => c && c.name && c.publication)
      .map(c => ({
        name: String(c.name), publication: String(c.publication),
        url: c.url || null, email: c.email || null, contact_url: c.contact_url || null,
        beats: Array.isArray(c.beats) ? c.beats.filter(b => KNOWN_BEATS.includes(b)) : [],
        why_fit: c.why_fit || '', added: false,
      }));
    await db.prepare("UPDATE discovery_runs SET status='complete', results=?, error=NULL WHERE id=?")
      .bind(JSON.stringify(candidates), discoveryId).run();
    await message.ack();
    await telegram(`🔎 <b>Discovery complete</b>\n${candidates.length} ${run.outlet_type} candidates for "${run.query.slice(0, 60)}"\nReview at publicist.engageengine.ai/discover`, env);
  } catch (err) {
    await db.prepare("UPDATE discovery_runs SET status='error', error=? WHERE id=?")
      .bind(String((err && err.message) || err).slice(0, 500), discoveryId).run();
    throw err; // let CF retry
  }
}

// Auth for discovery API: valid ee_session cookie (UI) OR Bearer INGEST_TOKEN (skill).
async function discoveryAuthed(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (env.INGEST_TOKEN && token === env.INGEST_TOKEN) return true;
  return eeValid(env, eeCookie(req, 'ee_session'));
}

async function handleDiscover(req, env) {
  if (!await discoveryAuthed(req, env)) return json({ error: 'Unauthorized' }, 401);
  let payload;
  try { payload = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const query = (payload.query || '').trim();
  if (!query) return json({ error: 'query is required' }, 400);
  const outletType = ['journalist', 'blog', 'podcast'].includes(payload.outlet_type) ? payload.outlet_type : 'podcast';
  const runId = uid();
  await env.DB.prepare(
    'INSERT INTO discovery_runs (id, query, outlet_type, market, status, created_at) VALUES (?,?,?,?,?,?)'
  ).bind(runId, query, outletType, payload.market || null, 'pending', now()).run();
  try {
    await env.PIPELINE_QUEUE.send({ discoveryId: runId });
  } catch {
    await env.DB.prepare("UPDATE discovery_runs SET status='error', error='queue unavailable' WHERE id=?").bind(runId).run();
    return json({ error: 'Service unavailable' }, 503);
  }
  return json({ ok: true, runId });
}

async function handleDiscoveryStatus(runId, req, env) {
  if (!await discoveryAuthed(req, env)) return json({ error: 'Unauthorized' }, 401);
  const run = await env.DB.prepare('SELECT * FROM discovery_runs WHERE id=?').bind(runId).first();
  if (!run) return json({ error: 'Not found' }, 404);
  return json({
    ok: true, id: run.id, status: run.status, query: run.query,
    outlet_type: run.outlet_type, market: run.market, error: run.error || null,
    candidates: run.results ? JSON.parse(run.results) : [],
  });
}

async function handleDiscoveryAdd(runId, req, env) {
  if (!await discoveryAuthed(req, env)) return json({ error: 'Unauthorized' }, 401);
  let payload;
  try { payload = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const idx = payload.index;
  const run = await env.DB.prepare('SELECT * FROM discovery_runs WHERE id=?').bind(runId).first();
  if (!run || !run.results) return json({ error: 'Not found' }, 404);
  const candidates = JSON.parse(run.results);
  const c = candidates[idx];
  if (!c) return json({ error: 'Bad index' }, 400);

  // Upsert into journalists (same matching as /api/import)
  let row = null;
  if (c.email) row = await env.DB.prepare('SELECT id FROM journalists WHERE lower(email)=lower(?)').bind(c.email).first();
  if (!row) row = await env.DB.prepare(
    "SELECT id FROM journalists WHERE lower(name)=lower(?) AND lower(coalesce(publication,''))=lower(?)"
  ).bind(c.name, c.publication || '').first();
  let journalistId;
  if (row) {
    journalistId = row.id;
  } else {
    journalistId = uid();
    await env.DB.prepare(
      'INSERT INTO journalists (id, name, email, publication, beat_keywords, outlet_type, contact_url) VALUES (?,?,?,?,?,?,?)'
    ).bind(journalistId, c.name, c.email || null, c.publication, JSON.stringify(c.beats || []), run.outlet_type, c.contact_url || c.url || null).run();
  }
  c.added = true;
  await env.DB.prepare('UPDATE discovery_runs SET results=? WHERE id=?').bind(JSON.stringify(candidates), runId).run();
  return json({ ok: true, journalistId });
}

// ── /discover page ────────────────────────────────────────────
async function discoverPage(req, env) {
  const runs = await env.DB.prepare('SELECT * FROM discovery_runs ORDER BY created_at DESC LIMIT 10').all().then(r => r.results || []);
  const runCards = runs.map(r => {
    const cands = r.results ? JSON.parse(r.results) : [];
    const cardsHtml = cands.map((c, i) => `
<div class="pitch-card" style="${c.added ? 'opacity:.55' : ''}">
  <div class="pitch-card-header">
    <div class="pitch-card-meta">
      <span class="pitch-journalist">${esc(c.name)}</span>
      <span class="pitch-pub">${esc(c.publication)}</span>
      ${(c.beats || []).map(b => `<span class="pitch-angle">${esc(b)}</span>`).join(' ')}
    </div>
    <div class="muted" style="margin-bottom:6px">
      ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a> · ` : ''}
      ${c.email ? esc(c.email) : (c.contact_url ? `contact: <a href="${esc(c.contact_url)}" target="_blank" rel="noopener">${esc(c.contact_url)}</a>` : 'no contact found')}
    </div>
    <div class="pitch-body-preview" style="-webkit-line-clamp:3">${esc(c.why_fit || '')}</div>
  </div>
  <div class="pitch-actions">
    ${c.added ? '<span style="color:var(--green);font-size:13px;font-weight:600">✓ In roster</span>'
      : `<button class="btn btn-green btn-sm" onclick="addCandidate('${r.id}', ${i}, this)">Add to Roster</button>`}
  </div>
</div>`).join('');
    return `
<div class="card" style="margin-bottom:20px">
  <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
    <h2 style="margin:0;font-size:15px">${esc(r.query)}</h2>
    <span class="muted">${esc(r.outlet_type)}${r.market ? ' · ' + esc(r.market) : ''} · ${r.status === 'complete' ? cands.length + ' candidates' : esc(r.status)}</span>
  </div>
  ${r.status === 'error' ? `<div class="alert alert-error" style="margin-top:10px">${esc(r.error || 'failed')}</div>` : ''}
  ${r.status === 'pending' || r.status === 'processing' ? '<div class="muted" style="margin-top:10px">Searching the web… refresh in ~1 minute.</div>' : ''}
  <div style="margin-top:14px">${cardsHtml}</div>
</div>`;
  }).join('') || '<div class="empty-state"><h3>No discovery runs yet</h3><p>Search for podcasts, blogs, or journalists above.</p></div>';

  const body = `
<div class="page-wide">
  <div class="card" style="margin-bottom:28px">
    <h2 style="font-size:15px;margin-bottom:14px">Find Outlets</h2>
    <form id="discoverForm" style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:12px;align-items:end">
      <div class="form-group" style="margin:0">
        <label>Topic / who you're pitching</label>
        <input type="text" id="dq" required placeholder="e.g. marketing podcasts that interview agency founders about local lead generation"
          style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px;padding:9px 12px;outline:none">
      </div>
      <div class="form-group" style="margin:0">
        <label>Outlet type</label>
        <select id="dt" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;padding:9px 12px;outline:none">
          <option value="podcast" selected>Podcasts</option>
          <option value="blog">Blogs</option>
          <option value="journalist">Journalists</option>
        </select>
      </div>
      <div class="form-group" style="margin:0">
        <label>Market (optional)</label>
        <input type="text" id="dm" placeholder="e.g. Columbia SC, or national"
          style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px;padding:9px 12px;outline:none">
      </div>
      <button type="submit" class="btn btn-primary" id="dbtn">Discover</button>
    </form>
    <div class="status-line" id="dstatus" style="margin-top:8px"></div>
  </div>
  ${runCards}
</div>
<script>
document.getElementById('discoverForm').addEventListener('submit', function(e) {
  e.preventDefault();
  var btn = document.getElementById('dbtn');
  btn.disabled = true; btn.textContent = 'Queuing…';
  fetch('/api/discover', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: document.getElementById('dq').value, outlet_type: document.getElementById('dt').value, market: document.getElementById('dm').value })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (!d.ok) { document.getElementById('dstatus').textContent = d.error || 'failed'; btn.disabled = false; btn.textContent = 'Discover'; return; }
    document.getElementById('dstatus').textContent = 'Searching the web — takes ~1-2 minutes. Page will refresh.';
    var poll = setInterval(function() {
      fetch('/api/discovery/' + d.runId).then(function(r) { return r.json(); }).then(function(s) {
        if (s.status === 'complete' || s.status === 'error') { clearInterval(poll); window.location.reload(); }
      });
    }, 8000);
  });
});
function addCandidate(runId, index, btn) {
  btn.disabled = true; btn.textContent = 'Adding…';
  fetch('/api/discovery/' + runId + '/add', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: index })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) { btn.outerHTML = '<span style="color:var(--green);font-size:13px;font-weight:600">✓ In roster</span>'; }
    else { btn.disabled = false; btn.textContent = 'Add to Roster'; }
  });
}
</script>`;
  return new Response(shell('Discover', body, 'discover'), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// ============================================================
// MAIN EXPORT
// ============================================================

export default {
  async fetch(req, env) {
    const eeBlocked = await eeGate(req, env, [/^\/api\/webhook\/resend$/, /^\/api\/health$/, /^\/api\/import$/, /^\/api\/roster$/, /^\/api\/discover$/, /^\/api\/discovery\//]);
    if (eeBlocked) return eeBlocked;

    // Validate required secrets at startup
    if (!env.ANTHROPIC_API_KEY) {
      return new Response('ANTHROPIC_API_KEY secret not set. Run: wrangler secret put ANTHROPIC_API_KEY', {
        status: 500,
      });
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Pages
    if (path === '/' || path === '') return redirect(req, '/brief', 302);
    if (path === '/brief') return briefPage(req, env);
    if (path === '/queue') return queuePage(req, env);
    if (path === '/coverage') return coveragePage(req, env);
    if (path === '/journalists') return journalistsPage(req, env);
    if (path === '/discover') return discoverPage(req, env);

    const progressMatch = path.match(/^\/progress\/([^/]+)$/);
    if (progressMatch) return progressPage(progressMatch[1], env);

    // API
    if (path === '/api/generate' && method === 'POST') return handleGenerate(req, env);
    if (path === '/api/import' && method === 'POST') return handleImportPlan(req, env);
    if (path === '/api/roster' && method === 'GET') return handleRoster(req, env);
    if (path === '/api/discover' && method === 'POST') return handleDiscover(req, env);
    const discoveryStatusMatch = path.match(/^\/api\/discovery\/([^/]+)$/);
    if (discoveryStatusMatch && method === 'GET') return handleDiscoveryStatus(discoveryStatusMatch[1], req, env);
    const discoveryAddMatch = path.match(/^\/api\/discovery\/([^/]+)\/add$/);
    if (discoveryAddMatch && method === 'POST') return handleDiscoveryAdd(discoveryAddMatch[1], req, env);
    if (path === '/api/interview' && method === 'POST') return handleInterview(req, env);

    const briefStatusMatch = path.match(/^\/api\/briefs\/([^/]+)\/status$/);
    if (briefStatusMatch) return handleBriefStatus(briefStatusMatch[1], env);

    const pitchMatch = path.match(/^\/api\/pitches\/([^/]+)\/(approve|skip)$/);
    if (pitchMatch && method === 'POST') return handlePitchAction(pitchMatch[1], pitchMatch[2], env);

    if (path === '/api/journalists' && method === 'POST') return handleAddJournalist(req, env);
    const journalistDeleteMatch = path.match(/^\/api\/journalists\/([^/]+)$/);
    if (journalistDeleteMatch && method === 'DELETE') return handleDeleteJournalist(journalistDeleteMatch[1], env);

    if (path === '/api/send' && method === 'POST') return handleSend(env);
    if (path === '/api/webhook/resend' && method === 'POST') return handleResendWebhook(req, env);
    if (path === '/api/coverage/poll' && method === 'POST') return handleCoveragePoll(env);

    if (path === '/api/health') return json({ ok: true, ts: Date.now() });

    return new Response('Not found', { status: 404 });
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      if (message.body && message.body.discoveryId) {
        await processDiscovery(message, env);
      } else {
        await processBrief(message, env);
      }
    }
  },
};
