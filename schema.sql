-- Run this in Supabase SQL Editor. Review before production use.
create extension if not exists pgcrypto;

create table if not exists public.audits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  source text not null,
  quantity numeric not null check (quantity >= 0),
  unit text not null default '',
  factor numeric not null check (factor >= 0),
  kg_co2e numeric not null check (kg_co2e >= 0),
  period text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.passports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization text not null,
  period text not null default '',
  audit_ids uuid[] not null default '{}',
  total_kg_co2e numeric not null check (total_kg_co2e >= 0),
  status text not null default 'estimated_not_verified',
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id text not null,
  payment_id text not null,
  status text not null default 'signature_verified',
  created_at timestamptz not null default now(),
  unique(payment_id)
);

alter table public.audits enable row level security;
alter table public.passports enable row level security;
alter table public.payments enable row level security;

-- Backend uses service-role key only on the server and explicitly scopes every query to auth user id.
-- Browser-side users have no direct table access in this starter. If direct client access is later enabled,
-- create explicit per-user RLS policies and never expose the service-role key.
revoke all on public.audits from anon, authenticated;
revoke all on public.passports from anon, authenticated;
revoke all on public.payments from anon, authenticated;
