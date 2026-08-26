-- Demo data for exercising the operational loop.
-- Run AFTER 0001_init.sql, in the Supabase SQL editor.
--
-- Items 1 and 2 deliberately share the SAME photo URL: they stand in for
-- the same physical garment entered twice. Selling item 1 should raise a
-- health flag against item 2 (Hamming distance 0). Item 3 has a different
-- photo and should never be flagged.

with seeded as (
  insert into inventory
    (title, brand, size, condition, purchase_cost,
     ebay_price, poshmark_price, depop_price, mercari_price, status, category)
  values
    ('90s Levi''s Denim Jacket', 'Levi''s', 'L', 'good', 18.00,
     78.00, 82.00, 75.00, 74.00, 'draft', 'outerwear'),
    ('Vintage Denim Jacket (dupe entry)', 'Levi''s', 'L', 'good', 18.00,
     78.00, 82.00, 75.00, 74.00, 'draft', 'outerwear'),
    ('Carhartt Duck Chore Coat', 'Carhartt', 'XL', 'fair', 25.00,
     95.00, 99.00, 92.00, 90.00, 'draft', 'outerwear')
  returning id, title
)
insert into listing_photos (inventory_id, url, position)
select
  s.id,
  case
    when s.title like '%Carhartt%'
      then 'https://picsum.photos/seed/ankrevibe-carhartt/600/800'
    else 'https://picsum.photos/seed/ankrevibe-denim/600/800'
  end,
  0
from seeded s;
