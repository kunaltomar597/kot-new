/** The time recommendations are worked out for (dayparts, rule hours); tests replace it (P3-04). */
export const RECOMMENDATION_CLOCK = Symbol('RECOMMENDATION_CLOCK');

export interface RecommendationClock {
  now(): Date;
}

export const SYSTEM_RECOMMENDATION_CLOCK: RecommendationClock = { now: () => new Date() };
