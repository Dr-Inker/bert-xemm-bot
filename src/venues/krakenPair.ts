/** Kraken REST uses BERTUSD; WS v2 book requires BERT/USD. */
export function toWsPair(pair: string): string {
  if (pair.includes('/')) return pair;
  const quotes = ['USDT', 'USD', 'EUR', 'GBP', 'JPY'] as const;
  for (const q of quotes) {
    if (pair.endsWith(q) && pair.length > q.length) {
      return `${pair.slice(0, -q.length)}/${q}`;
    }
  }
  return pair;
}
