/** Injectable clock — reminder and due-date logic must be testable at any instant. */
export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };
