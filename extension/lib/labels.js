// Matching a control by its visible wording.
//
// Split out of the automation scripts so it can be unit-tested. On a page
// full of destructive controls, which button a loose match picks is the
// difference between ending one listing and ending the wrong thing.
(function () {
  "use strict";

  /**
   * Whole-word match, case-insensitive.
   *
   * Substring matching is the obvious approach and the wrong one: "delete"
   * appears inside "Deleted items" and "Undelete", and "remove" inside
   * "Removed". Anchoring to word boundaries keeps those from matching.
   */
  function matchesLabel(text, wanted) {
    if (!text || !wanted) return false;
    const escaped = String(wanted).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(^|\\b)" + escaped + "(\\b|$)", "i").test(String(text));
  }

  /**
   * First candidate matching the highest-priority label.
   *
   * Priority is by LABEL, not by document order: a page showing both
   * "Mark as sold" and "Delete listing" should resolve to whichever the
   * caller ranked first, regardless of which appears higher in the DOM.
   */
  function findByLabels(candidates, labels) {
    for (const wanted of labels) {
      for (const candidate of candidates) {
        const text = candidate.text || "";
        const label = candidate.label || "";
        if (matchesLabel(text, wanted) || matchesLabel(label, wanted)) {
          return {
            candidate,
            matched: wanted,
            via: matchesLabel(text, wanted) ? "text" : "label",
          };
        }
      }
    }
    return null;
  }

  globalThis.AnkLabels = { matchesLabel, findByLabels };
})();
