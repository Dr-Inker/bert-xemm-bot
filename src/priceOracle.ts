import Decimal from 'decimal.js';

export interface PriceSample {
  source: string;
  midUsd: string;
}

export interface TrustedMidInput {
  samples: PriceSample[];
  maxDivergenceBps: number;
}

export type TrustedMidResult =
  | { trusted: true;  medianUsd: string }
  | { trusted: false; reason: string };

export function trustedMid(input: TrustedMidInput): TrustedMidResult {
  if (input.samples.length < 2) {
    return { trusted: false, reason: 'need at least 2 samples' };
  }
  const xs = input.samples.map(s => new Decimal(s.midUsd)).sort((a, b) => a.cmp(b));
  const min = xs[0]!;
  const max = xs[xs.length - 1]!;
  const median = xs.length % 2 === 1
    ? xs[(xs.length - 1) / 2]!
    : xs[xs.length / 2 - 1]!.plus(xs[xs.length / 2]!).div(2);
  const divBps = max.minus(min).div(median).mul(10_000);
  if (divBps.gt(input.maxDivergenceBps)) {
    return { trusted: false, reason: `divergence ${divBps.toFixed(1)}bps > ${input.maxDivergenceBps}bps` };
  }
  return { trusted: true, medianUsd: median.toString() };
}
