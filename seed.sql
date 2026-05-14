-- Agentic Publicist — Entity Seed Data
-- Run: npm run db:seed (local) or npm run db:seed:remote (production)

INSERT OR REPLACE INTO entities (id, name, type, bio_short, bio_long, expertise_keywords) VALUES
(
  'robbie',
  'Robbie Butt',
  'personal',
  'Marketing strategist and Google Ads specialist helping home service businesses — flooring, HVAC, plumbing, roofing — cut ad spend by 60–90% in 90 days. Founder of EngageEngine.',
  'Robbie Butt is a performance marketing strategist based in the United States who has spent the past five years working exclusively with home service businesses. He founded EngageEngine, an AI-powered marketing agency that helps flooring companies, HVAC contractors, plumbers, and roofers compete against larger competitors without inflating ad budgets.

Robbie''s methodology focuses on intent-based targeting: identifying homeowners at the exact moment they are searching for a service and presenting the right message at the right time. His clients routinely reduce cost-per-lead by 60–90% within the first 90 days by eliminating wasted ad spend on broad match keywords, irrelevant geographies, and audiences that never convert.

He built Marketing Performance, an analytics platform that surfaces real-time Google Ads and Meta performance data in a single dashboard, enabling small business owners to make data-driven decisions without a dedicated marketing team. The platform automates bid adjustments, audience suppression, and budget reallocation across campaigns.

Before founding EngageEngine, Robbie managed Google Ads accounts for regional flooring chains and multi-location home improvement brands, where he developed the repeatable system now used across all EngageEngine client accounts.

His public writing focuses on practical advertising tactics for home service owners: why broad match keywords drain budgets, how intent signals from floor-specific websites outperform demographic targeting, and why a 2X ROAS guarantee only works when the agency has full visibility into closed revenue — not just leads.

Robbie is building AI automation into every layer of the EngageEngine stack, including an agentic publicist that discovers journalists covering home services and marketing technology, drafts personalized media pitches based on the journalist''s recent coverage, and sends them through an approval queue — eliminating the need for a PR agency.',
  '["Google Ads", "home services", "flooring industry", "marketing automation", "AI automation", "performance marketing", "intent targeting", "SMB marketing", "ROAS optimization", "lead generation"]'
),
(
  'engageengine',
  'EngageEngine',
  'agency',
  'AI-powered marketing agency helping home service businesses — flooring, HVAC, plumbing, roofing — win more jobs at lower ad spend. 2X guarantee or we work free until it happens.',
  'EngageEngine is an AI-powered marketing agency founded by Robbie Butt that works exclusively with home service businesses. The agency specializes in Google Ads and Meta Ads management for flooring companies, HVAC contractors, plumbers, roofers, and other residential service providers.

The agency''s core promise is a 2X return on ad spend guarantee: if clients do not see a 2X ROAS improvement within 90 days, EngageEngine continues working without charging additional fees until the target is hit. This guarantee is only possible because the agency has built proprietary tooling — the Marketing Performance platform — that provides full visibility into campaign performance, lead quality, and closed revenue.

EngageEngine''s approach differs from traditional agencies in three ways. First, it uses intent data from industry-specific websites and buyer behavior signals to build custom audiences, rather than relying on demographic targeting that wastes spend on people who will never hire a home service contractor. Second, it integrates AI automation into every campaign — automatically suppressing low-intent audiences, reallocating budget to top-performing ad sets, and adjusting bids based on real-time conversion data. Third, it operates on a performance model where agency fees scale with client results, not with ad spend.

Current clients include regional flooring retailers, independent HVAC companies, and multi-location plumbing brands across the United States. The agency manages over $500,000 in annual ad spend across its client base.

EngageEngine is building toward a product-led growth model: Marketing Performance, its analytics platform, will eventually be available as a standalone SaaS product for home service businesses that manage their own advertising.',
  '["marketing agency", "Google Ads", "Meta Ads", "home services", "AI automation", "lead generation", "performance marketing", "flooring industry", "HVAC marketing", "SMB advertising"]'
),
(
  'marketingperformance',
  'Marketing Performance',
  'product',
  'Marketing analytics platform giving home service businesses real-time Google Ads and Meta performance data in one dashboard — with AI-powered bid optimization and audience automation built in.',
  'Marketing Performance is a marketing analytics and automation platform built specifically for home service businesses that advertise on Google and Meta. The platform was developed by EngageEngine to solve a problem its agency clients consistently faced: fragmented reporting across ad platforms, no visibility into which leads actually converted to closed jobs, and no way to act on performance data without a dedicated marketing team.

The platform aggregates Google Ads and Meta Ads data into a single real-time dashboard, surfacing the metrics that matter for home service businesses: cost per booked job (not just cost per lead), which keywords and audiences are generating revenue-positive conversions, and where ad spend is being wasted on clicks that never call or book.

Beyond reporting, Marketing Performance includes AI-powered automation layers: automatic bid adjustments based on historical conversion patterns, audience suppression for users who have already converted or who match low-intent behavioral signals, and budget reallocation across campaigns based on real-time ROAS performance.

The platform currently serves EngageEngine''s agency client base. A standalone SaaS version — enabling home service businesses to self-serve their marketing analytics and automation without hiring an agency — is in development.

Key differentiators versus generic analytics platforms like Google Analytics or Agency Analytics:
- Home service-specific metrics and benchmarks (cost per booked job, seasonal demand patterns, competitor auction data)
- Direct integration with CRM systems used by home service businesses (ServiceTitan, Jobber, Housecall Pro) to close the loop between ad spend and closed revenue
- AI automation that acts on the data, not just reports it
- Built by an agency that manages real campaigns, so the metrics and automation rules reflect what actually moves the needle',
  '["marketing analytics", "campaign optimization", "SMB marketing", "Google Ads automation", "Meta Ads automation", "performance tracking", "home services SaaS", "bid optimization", "audience automation", "marketing dashboard"]'
);
