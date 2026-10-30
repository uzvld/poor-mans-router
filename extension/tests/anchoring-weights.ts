import type { FacetWeights } from '../bench-types.ts';

/**
 * The blend the intelligence-anchoring tests were written under: 0.24 coding and 0.14 agentic, and nothing
 * for the general facet. Those tests pin how an intelligence-only model is placed against a measured one
 * (reference choice, the 0.10 credit cap, the order between lineages, I7), not what a tier weights, so they
 * score routes with fixed weights and stay independent of the tier policy. What the tier weights do is
 * pinned in bench-weights.test.ts.
 */
export const ANCHORING_WEIGHTS: FacetWeights = { coding: 0.24, agentic: 0.14, general: 0 };
