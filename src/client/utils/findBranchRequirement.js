'use strict';
/**
 * Match identities from the Host tree, retaining the actual spelling and path.
 * @param tree - The Host-provided requirement tree.
 * @param parsed - Parsed branch identity.
 * @param [caseSensitivePaths] - Whether path spelling must match exactly.
 * @returns The unique match and an ambiguity flag.
 */
function findBranchRequirement(tree, parsed, caseSensitivePaths = true) {
  const entries = (tree?.developers || []).flatMap((dev) =>
    (dev.requirements || []).map((req) => ({ ...req, developer: dev.name })),
  );
  const exact = entries.filter(
    (req) =>
      (!parsed.developer || req.developer === parsed.developer) && req.id === parsed.requirementId,
  );
  if (exact.length) {
    return { match: exact.length === 1 ? exact[0] : null, ambiguous: exact.length > 1 };
  }
  if (caseSensitivePaths) {
    return { match: null, ambiguous: false };
  }
  const folded = entries.filter(
    (req) =>
      (!parsed.developer || req.developer.toLowerCase() === parsed.developer.toLowerCase()) &&
      req.id.toLowerCase() === parsed.requirementId.toLowerCase(),
  );
  return { match: folded.length === 1 ? folded[0] : null, ambiguous: folded.length > 1 };
}
module.exports = { findBranchRequirement };
