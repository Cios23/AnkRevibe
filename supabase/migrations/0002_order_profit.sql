-- Profit on a sale, computed at the time the sale is recorded.
--
-- Stored rather than derived on read because the fee model changes: eBay
-- and Poshmark adjust their rates, and a historical order should keep the
-- economics it was actually booked under, not be silently restated by a
-- later rate change.
--
-- platform_fee is stored alongside so the number is auditable - a profit
-- figure with no visible fee cannot be checked against a payout report.

alter table orders add column if not exists platform_fee numeric;
alter table orders add column if not exists profit numeric;

comment on column orders.platform_fee is
  'Estimated marketplace selling fee at sale time. See lib/fees.ts.';
comment on column orders.profit is
  'sale_price - platform_fee - inventory.purchase_cost, at sale time. An
   estimate: excludes shipping, promoted-listing fees and refunds.';
