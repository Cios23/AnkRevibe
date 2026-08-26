// Margin arithmetic for the Poshmark offer automation.
//
// Split out of offer-sender.js so it can be unit-tested (test/margin.test.mts)
// rather than only exercised by driving a live marketplace page. It decides
// what we are willing to sell for, so being wrong here costs real money.
(function () {
  "use strict";

  /**
   * Poshmark's published seller commission: a flat $2.95 under $15,
   * otherwise 20%.
   *
   * Without this, "profit" is just the sticker price. A $12 offer on an item
   * that cost $9 reads as $3 of profit; the flat fee leaves five cents.
   */
  function poshmarkNetProceeds(price) {
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 15 ? n - 2.95 : n * 0.8;
  }

  /**
   * Should we make/accept an offer at this price?
   *
   * Returns a reason as well as a verdict so a run can report why items were
   * passed over, rather than silently doing nothing.
   *
   * `requireKnownCost` defaults to true: with no purchase_cost we cannot
   * reason about margin at all, and quietly falling back to a price floor
   * would make a margin setting mean something it does not.
   */
  function evaluateOffer(offerPrice, purchaseCost, options) {
    const opts = options || {};
    const minProfit = Number(opts.minProfit) || 0;
    const requireKnownCost = opts.requireKnownCost !== false;

    const price = Number(offerPrice);
    if (!Number.isFinite(price) || price <= 0) {
      return { ok: false, reason: "invalid price", margin: null };
    }

    const cost = purchaseCost == null ? null : Number(purchaseCost);

    if (cost == null || !Number.isFinite(cost)) {
      if (requireKnownCost) {
        return { ok: false, reason: "no purchase_cost", margin: null };
      }
      return {
        ok: price >= minProfit,
        reason: "price floor (cost unknown)",
        margin: null,
      };
    }

    const net = poshmarkNetProceeds(price);
    const margin = net - cost;
    return {
      ok: margin >= minProfit,
      reason: "margin " + margin.toFixed(2),
      margin: margin,
      net: net,
    };
  }

  globalThis.AnkMargin = { poshmarkNetProceeds, evaluateOffer };
})();
