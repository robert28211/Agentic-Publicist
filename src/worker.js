// Agentic Publicist — Single Cloudflare Worker
// Auth: Cloudflare Access (Zero Trust) — no auth code needed here
// Async pipeline: Queue Consumer handles brief → angles → pitches

// ============================================================
// CONSTANTS
// ============================================================

export const BEAT_DOMAINS = {
  'marketing-tech': ['techcrunch.com', 'marketingland.com', 'searchengineland.com', 'adweek.com'],
  'home-services': ['contractortalk.com', 'remodeling.hw.net', 'probuilder.com', 'housingwire.com'],
  'ai-automation': ['venturebeat.com', 'zdnet.com', 'the-decoder.com', 'artificialintelligence-news.com'],
  'flooring-industry': ['floorcoveringnews.net', 'floordaily.net', 'fcnews.net'],
  'small-business': ['entrepreneur.com', 'inc.com', 'businessinsider.com', 'forbes.com'],
  'digital-marketing': ['searchengineland.com', 'marketingland.com', 'adweek.com', 'digiday.com'],
  'construction': ['constructiondive.com', 'enr.com', 'contractingbusiness.com'],
};

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

export function getDomainsForBeat(beat) {
  return BEAT_DOMAINS[beat] || [];
}

// ============================================================
// CLAUDE API
// ============================================================

async function callClaude(messages, systemText, env, { cacheSystem = false, maxTokens = 1024 } = {}) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
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
  return data.content[0].text;
}

// Call 1 — Angle Generation
async function generateAngles(briefBody, entity, headlines, env) {
  const system = `You are the publicist agent for ${entity.name}.
Type: ${entity.type}
Expertise: ${entity.expertise_keywords}
Bio: ${entity.bio_long}

Rules:
- Generate story angles only, no pitches yet
- Each angle must be genuinely newsworthy, not promotional
- Reference current news context where relevant
- Return valid JSON only`;

  const user = `Brief: ${briefBody}
Today's date: ${new Date().toISOString().split('T')[0]}
Top headlines today: ${headlines.join(' | ')}

Return a JSON array of exactly 3 story angles:
[{"angle": "string", "beat": "one of: marketing-tech|home-services|ai-automation|flooring-industry|small-business|digital-marketing|construction", "publication_type": "string"}]`;

  const text = await callClaude(
    [{ role: 'user', content: user }],
    system,
    env,
    { cacheSystem: true, maxTokens: 512 }
  );

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Claude returned no JSON array for angles');
  return JSON.parse(match[0]);
}

// Call 3 — Pitch Drafting (per journalist)
async function draftPitch(journalist, entity, angle, briefBody, articleTitle, articleSnippet, env) {
  const system = `You are drafting a media pitch on behalf of ${entity.name}.
Entity bio: ${entity.bio_long}
Expertise: ${entity.expertise_keywords}

Rules:
- Reference a specific article the journalist wrote (provided below)
- 150 words max for body
- Subject line 7 words max, no clickbait, no ALL CAPS
- Never fabricate quotes or statistics not in the brief
- Write in first person as if from ${entity.name}
- Be specific about why THIS journalist at THIS publication
- Return valid JSON only`;

  const user = `Journalist: ${journalist.name}, ${journalist.publication}
Their recent article: "${articleTitle}" — ${articleSnippet || 'recent coverage'}

Brief: ${briefBody}
Story angle for this journalist: ${angle.angle}

Write: subject line + email body.
Return JSON: {"subject": "string", "body": "string"}`;

  const text = await callClaude(
    [{ role: 'user', content: user }],
    system,
    env,
    { cacheSystem: true, maxTokens: 512 }
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
// HUNTER.IO
// ============================================================

async function hunterDomainSearch(domain, env) {
  if (!env.HUNTER_API_KEY) return [];
  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&type=journalist&limit=5&api_key=${env.HUNTER_API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data?.emails || []).map(e => ({
      name: `${e.first_name || ''} ${e.last_name || ''}`.trim() || 'Unknown',
      email: e.value,
      publication: domain,
      position: e.position || '',
    }));
  } catch {
    return [];
  }
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
    { step: 'Searching journalists', done: false, ts: null },
    { step: 'Drafting pitches', done: false, ts: null },
  ];

  try {
    // Step 1: Fetch current headlines for context
    steps[0].done = true; steps[0].ts = now();
    await updateProgress(steps);

    const headlines = await getTopHeadlines('marketing technology AI automation');

    // Step 2: Generate angles (Call 1 — cached system prompt)
    steps[1].done = true; steps[1].ts = now();
    await updateProgress(steps);

    const angles = await generateAngles(brief.body, entity, headlines, env);
    await db.prepare('UPDATE briefs SET angles=? WHERE id=?')
      .bind(JSON.stringify(angles), briefId).run();

    // Step 3: Journalist discovery (per angle, parallel)
    steps[2].done = true; steps[2].ts = now();
    await updateProgress(steps);

    const journalistResults = await Promise.allSettled(
      angles.flatMap(angle => {
        const domains = getDomainsForBeat(angle.beat);
        return domains.map(domain => hunterDomainSearch(domain, env));
      })
    );

    // Collect and dedup by email
    const emailSeen = new Set();
    const rawJournalists = journalistResults
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(j => {
        if (!j.email || emailSeen.has(j.email)) return false;
        emailSeen.add(j.email);
        return true;
      });

    // Upsert journalists into D1
    for (const j of rawJournalists) {
      const existing = await db.prepare('SELECT id, last_contacted_at FROM journalists WHERE email=?').bind(j.email).first();
      if (!existing) {
        await db.prepare(
          'INSERT INTO journalists (id, name, email, publication, beat_keywords, last_contacted_at) VALUES (?,?,?,?,?,?)'
        ).bind(uid(), j.name, j.email, j.publication, JSON.stringify([]), null).run();
      }
    }

    // Fetch from D1 (includes last_contacted_at)
    const allJournalists = rawJournalists.length
      ? await db.prepare(
          `SELECT * FROM journalists WHERE email IN (${rawJournalists.map(() => '?').join(',')}) LIMIT 20`
        ).bind(...rawJournalists.map(j => j.email)).all().then(r => r.results)
      : [];

    // Filter by 30-day cooldown (cross-brief rate limiting)
    const eligible = filterEligibleJournalists(allJournalists);

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
    await db.prepare("UPDATE briefs SET status='error' WHERE id=?").bind(briefId).run();
    // Do NOT ack — let Cloudflare retry up to max_retries
    throw err;
  }
}

// ============================================================
// HTML PAGES
// ============================================================

const CSS = `
:root {
  --bg: #0a0a0f;
  --surface: #13131a;
  --border: #1e1e2e;
  --text: #e8e8f0;
  --dim: #8888a8;
  --accent: #4f8cff;
  --green: #22c55e;
  --amber: #f59e0b;
  --red: #ef4444;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 15px; line-height: 1.5; }
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
.sentiment-badge.neutral { background: rgba(136,136,168,.15); color: var(--dim); }
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
  const selectedEntity = url.searchParams.get('entity') || 'engageengine';
  const msg = url.searchParams.get('msg');

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

  const body = `
<div class="page">
  ${msgHtml}
  <div style="margin-bottom:28px">
    <div class="label" style="margin-bottom:10px">Entity</div>
    <select id="entitySelect" onchange="window.location='/brief?entity='+this.value">
      <option value="engageengine" ${selectedEntity === 'engageengine' ? 'selected' : ''}>EngageEngine</option>
      <option value="robbie" ${selectedEntity === 'robbie' ? 'selected' : ''}>Robbie Butt</option>
      <option value="marketingperformance" ${selectedEntity === 'marketingperformance' ? 'selected' : ''}>Marketing Performance</option>
    </select>
    <div class="status-line" style="margin-top:8px">${lastRun}</div>
  </div>

  <form method="POST" action="/api/generate" id="briefForm">
    <input type="hidden" name="entity_id" value="${selectedEntity}">
    <div class="form-group">
      <textarea name="body" id="briefBody" placeholder="Paste your announcement brief — what happened, why it matters, who should care" required></textarea>
    </div>
    <div style="display:flex;align-items:center;gap:16px">
      <button type="submit" class="btn btn-primary" id="submitBtn">Generate Pitches</button>
      <span class="muted">~45 seconds</span>
    </div>
  </form>
</div>
<script>
document.getElementById('briefForm').addEventListener('submit', function() {
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
// API HANDLERS
// ============================================================

async function handleGenerate(req, env) {
  const form = await req.formData();
  const entityId = form.get('entity_id');
  const body = (form.get('body') || '').trim();

  if (!entityId || !body) {
    return Response.redirect('/brief?msg=error', 303);
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

  return Response.redirect(`/progress/${briefId}`, 303);
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

// ============================================================
// MAIN EXPORT
// ============================================================

export default {
  async fetch(req, env) {
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
    if (path === '/' || path === '') return Response.redirect('/brief', 302);
    if (path === '/brief') return briefPage(req, env);
    if (path === '/queue') return queuePage(req, env);
    if (path === '/coverage') return coveragePage(req, env);

    const progressMatch = path.match(/^\/progress\/([^/]+)$/);
    if (progressMatch) return progressPage(progressMatch[1], env);

    // API
    if (path === '/api/generate' && method === 'POST') return handleGenerate(req, env);

    const briefStatusMatch = path.match(/^\/api\/briefs\/([^/]+)\/status$/);
    if (briefStatusMatch) return handleBriefStatus(briefStatusMatch[1], env);

    const pitchMatch = path.match(/^\/api\/pitches\/([^/]+)\/(approve|skip)$/);
    if (pitchMatch && method === 'POST') return handlePitchAction(pitchMatch[1], pitchMatch[2], env);

    if (path === '/api/send' && method === 'POST') return handleSend(env);
    if (path === '/api/webhook/resend' && method === 'POST') return handleResendWebhook(req, env);
    if (path === '/api/coverage/poll' && method === 'POST') return handleCoveragePoll(env);

    if (path === '/api/health') return json({ ok: true, ts: Date.now() });

    return new Response('Not found', { status: 404 });
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      await processBrief(message, env);
    }
  },
};
