-- AnK ReVibe — initial schema
-- Two-user private app: both users share full access. No per-row ownership.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- inventory
create table inventory (
  id uuid primary key default gen_random_uuid(),
  title text,
  description text,
  brand text,
  size text,
  color text,
  condition text,
  flaw_notes text,
  measurements jsonb,
  purchase_cost numeric,
  ebay_price numeric,
  poshmark_price numeric,
  depop_price numeric,
  mercari_price numeric,
  status text default 'draft', -- draft | active | sold | archived
  category text,
  subcategory text,
  style_era text,
  created_at timestamptz default now(),
  sold_at timestamptz,
  sold_platform text,
  sold_price numeric
);

-- ----------------------------------------------------------- listing_photos
create table listing_photos (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid references inventory(id) on delete cascade,
  url text not null,
  position int default 0,
  phash text, -- perceptual hash, computed on upload, used for
              -- sync-failure / duplicate detection
  created_at timestamptz default now()
);

-- --------------------------------------------------------- platform_listings
create table platform_listings (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid references inventory(id) on delete cascade,
  platform text not null, -- 'ebay' | 'poshmark' | 'depop' | 'mercari'
  platform_listing_id text,
  platform_url text,
  status text default 'active', -- active | delisted | error
  listed_price numeric,
  listed_at timestamptz default now(),
  delisted_at timestamptz,
  last_relisted_at timestamptz,
  unique (inventory_id, platform)
);

-- ------------------------------------------------------------------- orders
create table orders (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid references inventory(id),
  platform text,
  sale_price numeric,
  buyer_info jsonb,
  status text default 'pending', -- pending | shipped | completed
  shipped_at timestamptz,
  tracking_number text,
  created_at timestamptz default now()
);

-- ------------------------------------------------------ inventory_health_flags
-- Inventory Health: sync-failure detection.
-- When an item sells on one platform, we hash-compare its photos
-- against photos of OTHER active listings. A close phash match means
-- the same physical item is likely still live somewhere it shouldn't
-- be (delist failed / sync missed it).
create table inventory_health_flags (
  id uuid primary key default gen_random_uuid(),
  sold_inventory_id uuid references inventory(id),
  flagged_inventory_id uuid references inventory(id),
  similarity_score numeric, -- lower = closer match (Hamming distance)
  status text default 'open', -- open | dismissed | resolved
  created_at timestamptz default now()
);

-- ------------------------------------------------------------------ indexes
-- Postgres does not auto-index FK columns; these back the JOINs and cascades.
create index listing_photos_inventory_id_idx on listing_photos (inventory_id);
create index orders_inventory_id_idx on orders (inventory_id);
create index inventory_health_flags_sold_idx on inventory_health_flags (sold_inventory_id);
create index inventory_health_flags_flagged_idx on inventory_health_flags (flagged_inventory_id);
-- platform_listings.inventory_id is already covered by the leading column of
-- the unique (inventory_id, platform) index.
create index inventory_status_idx on inventory (status);
create index platform_listings_status_idx on platform_listings (status);
create index inventory_health_flags_status_idx on inventory_health_flags (status);

-- --------------------------------------------------------------------- RLS
-- Both users get full access to everything. Policies are scoped `to
-- authenticated` so the anon key alone can never read or write, and
-- auth.uid() is wrapped in a subselect so it is evaluated once per
-- statement rather than once per row.
alter table inventory enable row level security;
alter table listing_photos enable row level security;
alter table platform_listings enable row level security;
alter table orders enable row level security;
alter table inventory_health_flags enable row level security;

create policy authenticated_full_access on inventory
  for all to authenticated
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

create policy authenticated_full_access on listing_photos
  for all to authenticated
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

create policy authenticated_full_access on platform_listings
  for all to authenticated
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

create policy authenticated_full_access on orders
  for all to authenticated
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);

create policy authenticated_full_access on inventory_health_flags
  for all to authenticated
  using ((select auth.uid()) is not null)
  with check ((select auth.uid()) is not null);
