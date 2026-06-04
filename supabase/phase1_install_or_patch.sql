-- Nexus AI Phase 1 final install/patch.
-- Safe to run after earlier Nexus tables. It creates/patches all Phase 1 marketplace tables.

create extension if not exists "pgcrypto";

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  full_name text,
  role text not null default 'buyer' check (role in ('admin','buyer','developer')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists developers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id) on delete set null,
  display_name text not null,
  handle text unique not null,
  type text default 'Verified Operator',
  avatar_letter text default 'N',
  short_description text,
  bio text,
  website text,
  skills text[] default '{}',
  verified boolean default false,
  rating numeric default 0,
  review_count integer default 0,
  status text default 'active' check (status in ('active','hidden','pending')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists automations (
  id uuid primary key default gen_random_uuid(),
  developer_id uuid references developers(id) on delete set null,
  title text not null,
  slug text unique not null,
  category text,
  badge text,
  icon text default 'AI',
  color text default 'blue',
  status text default 'draft' check (status in ('draft','live','paused','archived')),
  featured boolean default false,
  pricing_type text default 'custom_quote' check (pricing_type in ('free_demo','one_time','monthly','setup_fee','custom_quote')),
  currency text default 'USD' check (currency in ('USD','THB')),
  price numeric default 0,
  setup_fee numeric default 0,
  delivery_time text,
  setup_type text,
  best_for text,
  rating numeric default 0,
  review_count integer default 0,
  sales_count integer default 0,
  preview_type text default 'custom',
  short_description text,
  long_description text,
  problem text,
  outcome text,
  who_it_is_for text[] default '{}',
  outputs text[] default '{}',
  required_inputs text[] default '{}',
  required_tools text[] default '{}',
  setup_steps text[] default '{}',
  trust_points text[] default '{}',
  internal_notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table automations
  add column if not exists price_usd numeric default 0,
  add column if not exists price_thb numeric default 0,
  add column if not exists setup_fee_usd numeric default 0,
  add column if not exists setup_fee_thb numeric default 0,
  add column if not exists preview_mode text default 'template',
  add column if not exists preview_title text,
  add column if not exists preview_description text,
  add column if not exists preview_code text,
  add column if not exists preview_image_url text,
  add column if not exists preview_base64 text,
  add column if not exists customizations jsonb default '[]'::jsonb;

alter table developers
  add column if not exists banner_url text,
  add column if not exists banner_base64 text,
  add column if not exists banner_color text default 'linear-gradient(135deg,#2563ff,#00c2ff)';

create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid references automations(id) on delete cascade,
  reviewer_name text not null,
  rating numeric not null default 5,
  review_text text,
  status text default 'approved' check (status in ('pending','approved','hidden')),
  created_at timestamptz default now()
);

create table if not exists developer_waitlist (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text,
  website text,
  automation_type text,
  automation_categories text[] not null default '{}'::text[],
  build_stack text[] not null default '{}'::text[],
  build_stack_other text,
  experience text,
  message text,
  status text default 'new',
  created_at timestamptz default now()
);

alter table developer_waitlist
  add column if not exists automation_categories text[] not null default '{}'::text[],
  add column if not exists build_stack text[] not null default '{}'::text[],
  add column if not exists build_stack_other text;

create index if not exists idx_developer_waitlist_automation_categories
on developer_waitlist using gin (automation_categories);

create index if not exists idx_developer_waitlist_build_stack
on developer_waitlist using gin (build_stack);

create table if not exists contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text,
  inquiry_type text,
  message text,
  status text default 'new',
  created_at timestamptz default now()
);

create table if not exists checkout_intents (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid references automations(id) on delete set null,
  automation_title text,
  install_type text,
  selected_customization text,
  currency text default 'USD',
  price_display text,
  name text,
  email text,
  company text,
  website text,
  notes text,
  status text default 'phase1_saved',
  created_at timestamptz default now()
);

create index if not exists idx_automations_status on automations(status);
create index if not exists idx_automations_slug on automations(slug);
create index if not exists idx_automations_developer on automations(developer_id);
create index if not exists idx_reviews_automation on reviews(automation_id);

alter table profiles enable row level security;
alter table developers enable row level security;
alter table automations enable row level security;
alter table reviews enable row level security;
alter table developer_waitlist enable row level security;
alter table contact_messages enable row level security;
alter table checkout_intents enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
security definer
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
    and role = 'admin'
  );
$$;

drop policy if exists "Admins can read profiles" on profiles;
create policy "Admins can read profiles"
on profiles for select
using (public.is_admin() or id = auth.uid());

drop policy if exists "Admins manage profiles" on profiles;
create policy "Admins manage profiles"
on profiles for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Public read active developers" on developers;
create policy "Public read active developers"
on developers for select
using (status = 'active' or public.is_admin());

drop policy if exists "Admins manage developers" on developers;
create policy "Admins manage developers"
on developers for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Public read live automations" on automations;
create policy "Public read live automations"
on automations for select
using (status = 'live' or public.is_admin());

drop policy if exists "Admins manage automations" on automations;
create policy "Admins manage automations"
on automations for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Public read approved reviews" on reviews;
create policy "Public read approved reviews"
on reviews for select
using (status = 'approved' or public.is_admin());

drop policy if exists "Admins manage reviews" on reviews;
create policy "Admins manage reviews"
on reviews for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Public can create developer waitlist" on developer_waitlist;
create policy "Public can create developer waitlist"
on developer_waitlist for insert
with check (true);

drop policy if exists "Admins manage developer waitlist" on developer_waitlist;
create policy "Admins manage developer waitlist"
on developer_waitlist for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Public can create contact messages" on contact_messages;
create policy "Public can create contact messages"
on contact_messages for insert
with check (true);

drop policy if exists "Admins manage contact messages" on contact_messages;
create policy "Admins manage contact messages"
on contact_messages for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Public can create checkout intents" on checkout_intents;
create policy "Public can create checkout intents"
on checkout_intents for insert
with check (true);

drop policy if exists "Admins manage checkout intents" on checkout_intents;
create policy "Admins manage checkout intents"
on checkout_intents for all
using (public.is_admin())
with check (public.is_admin());

insert into developers (
  display_name, handle, type, avatar_letter, short_description, bio, website, skills, verified, rating, review_count, status, banner_color
) values (
  'Nexus Internal',
  'nexus-internal',
  'Verified Nexus Operator',
  'N',
  'The internal Nexus team building and operating the first marketplace automations.',
  'Nexus Internal is the first verified operator on the platform. These automations are built, packaged, monitored, and supported by Nexus directly while the marketplace validates demand and the product model.',
  'https://nexus-ai.software',
  array['AI automation','n8n/Make workflows','Business reporting','Chatbots','Social listening','Automation productization'],
  true,
  4.9,
  0,
  'active',
  'linear-gradient(135deg,#2563ff,#00c2ff)'
)
on conflict (handle) do update set
  display_name = excluded.display_name,
  type = excluded.type,
  avatar_letter = excluded.avatar_letter,
  short_description = excluded.short_description,
  bio = excluded.bio,
  website = excluded.website,
  skills = excluded.skills,
  verified = excluded.verified,
  rating = excluded.rating,
  status = excluded.status,
  banner_color = excluded.banner_color;

with dev as (select id from developers where handle = 'nexus-internal')
insert into automations (
  developer_id,title,slug,category,badge,icon,color,status,featured,pricing_type,currency,price,price_usd,price_thb,setup_fee,setup_fee_usd,setup_fee_thb,delivery_time,setup_type,best_for,rating,review_count,sales_count,preview_type,preview_mode,short_description,long_description,problem,outcome,who_it_is_for,outputs,required_inputs,required_tools,setup_steps,trust_points,customizations
)
select dev.id,'Social Listening Intelligence','social-listening-intelligence','Marketing','Brand Intelligence','SL','blue','live',true,'monthly','USD',59,59,2100,0,0,0,'24-48 hours','Self-serve or guided','Marketing, PR, agencies',4.9,18,42,'listening','template','Monitor brand health, sentiment, competitor moves, risks, and trends without building your own listening stack.','A Nexus-hosted social listening automation that tracks mentions, sentiment, topics, competitor signals, risks, recurring complaints, and opportunities. Businesses receive clean insight outputs without managing the workflow.','Businesses know they should monitor what people say about them, but manual checking is slow and most social listening tools are too expensive or too complicated for small teams.','A repeatable brand intelligence report and alert system that tells the business what changed, what customers are saying, what risks are emerging, and what actions to take next.',array['Brands monitoring reputation','Marketing teams tracking campaign response','Agencies reporting to clients','Operators needing early warning signals'],array['Brand mention summaries','Sentiment breakdowns','Complaint and praise themes','Competitor signals','Urgent alert recommendations'],array['Brand name','Competitors','Keywords','Social links','Reporting frequency'],array['Google Reviews','Social links','Optional platform exports','Email or Slack for delivery'],array['Submit monitoring rules','Connect or provide sources','Choose alert/reporting frequency','Receive insight reports'],array['Hosted through Nexus','Buyer does not manage workflows','Outputs are standardized','Can be monitored and paused if unreliable'],'[{"name":"Executive summary","description":"Turns raw monitoring into leadership-ready bullet points.","price_note":"Included","preview_mode":"code","preview_code":"Brand Summary\\n- Positive sentiment rose 8%\\n- Queue time is the main complaint\\n- Competitor launched a promotion\\n- Recommended action: respond to queue complaints"}]'::jsonb
from dev
on conflict (slug) do nothing;

with dev as (select id from developers where handle = 'nexus-internal')
insert into automations (
  developer_id,title,slug,category,badge,icon,color,status,featured,pricing_type,currency,price,price_usd,price_thb,setup_fee,delivery_time,setup_type,best_for,rating,review_count,sales_count,preview_type,preview_mode,short_description,long_description,problem,outcome,who_it_is_for,outputs,required_inputs,required_tools,setup_steps,trust_points
)
select dev.id,'AI Social Media Reports','ai-social-media-reports','Reporting','Performance Reporting','SR','green','live',true,'monthly','USD',69,69,2500,0,'24-48 hours','Self-serve or guided','Marketing teams, agencies',4.8,23,57,'reports','template','Turn raw social performance data into clean business reports, insights, and next-step recommendations.','This automation converts social media performance data into structured reports explaining what worked, what declined, where attention is needed, and what actions should be taken next.','Most teams spend too much time collecting screenshots, copying metrics, and writing repetitive performance summaries.','A clean report that explains performance, highlights winning content, identifies weak points, and suggests what to post or test next.',array['Marketing managers','Agencies','Brands comparing content performance','Teams tired of manual reporting'],array['Performance summary','Best and worst content analysis','Engagement/reach explanation','Audience response insights','Next-step recommendations'],array['Social links','Reporting period','Business goal','Campaign context','Data export or account connection'],array['Social media accounts or exports','Google Sheets optional','PDF/email output'],array['Upload/connect data','Choose report period','Add business goals','Receive clean report output'],array['Business-ready output','No dashboard building required','Reviewed by Nexus','Repeatable delivery']
from dev
on conflict (slug) do nothing;

with dev as (select id from developers where handle = 'nexus-internal')
insert into automations (
  developer_id,title,slug,category,badge,icon,color,status,featured,pricing_type,currency,price,price_usd,price_thb,setup_fee,setup_fee_usd,setup_fee_thb,delivery_time,setup_type,best_for,rating,review_count,sales_count,preview_type,preview_mode,short_description,long_description,problem,outcome,who_it_is_for,outputs,required_inputs,required_tools,setup_steps,trust_points
)
select dev.id,'AI Customer Support Chatbot','ai-customer-support-chatbot','Customer Support','24/7 Support','CB','purple','live',true,'monthly','USD',79,79,2900,299,299,10900,'2-5 days','Guided install recommended','Support, sales, service teams',4.9,31,64,'chatbot','template','Launch a chatbot trained on your business so customers get answers anytime.','An AI chatbot productized by Nexus. It answers common questions, captures leads, guides customers, and escalates complex cases using approved business information.','Businesses lose time answering the same questions every day, but building a safe customer-facing chatbot takes prompt design, data preparation, installation, and support planning.','A trained business chatbot that can answer common questions, collect leads, escalate when needed, and provide summaries of customer needs.',array['Support teams','Sales teams','Service businesses','Tourism and hospitality companies'],array['24/7 customer answers','Lead capture','Escalation to human team','Conversation summaries','Customer question insights'],array['FAQs','Business hours','Policies','Products/services','Tone of voice','Escalation email'],array['Website widget','Knowledge base','Optional CRM connection'],array['Submit knowledge base','Choose tone','Set escalation rules','Deploy chatbot'],array['Trained on approved information','Human escalation available','Customer sees only the assistant','Nexus manages setup']
from dev
on conflict (slug) do nothing;
