import { Connection, PublicKey } from '@solana/web3.js';
import type { RpcAdapter } from './raydiumAmmClient.js';

export interface SolanaRpcAdapterOpts {
  connection: Connection;
  poolAddress: string;
  hotWalletPubkey?: string;
  bertMint: string;
  // Cache TTLs to limit RPC + HTTP burn
  poolStateCacheMs?: number;
  balanceCacheMs?: number;
}

interface PoolState { baseVault: string; quoteVault: string; baseDecimals: number; quoteDecimals: number }

export class SolanaRpcAdapter implements RpcAdapter {
  private poolCache: { value: PoolState; at: number } | null = null;
  private balanceCache = new Map<string, { value: { uiAmount: string; amount: string; decimals: number }; at: number }>();
  private walletCache: { value: { bert: string; sol: string }; at: number } | null = null;

  constructor(private opts: SolanaRpcAdapterOpts) {}

  async getPoolState(poolAddress: string): Promise<PoolState> {
    const ttl = this.opts.poolStateCacheMs ?? 60_000;
    if (this.poolCache && Date.now() - this.poolCache.at < ttl) return this.poolCache.value;
    // Use DexScreener to get token mints + decimals, then derive vault addresses via Raydium SDK or known layout.
    // For Phase 1 simplicity, we query DexScreener which exposes baseToken/quoteToken with decimals,
    // and we treat the pool address itself as a proxy for vault lookups (RaydiumAmmClient.poolMidUsd
    // calls getTokenBalance with the vault addresses we return here).
    const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`);
    if (!r.ok) throw new Error(`dexscreener pool ${r.status}`);
    const j = await r.json() as { pair?: { baseToken: { address: string; decimals?: number }; quoteToken: { address: string; decimals?: number } } };
    if (!j.pair) throw new Error(`dexscreener pair empty for ${poolAddress}`);
    // For DexScreener-based reserve reads, we use the pool address itself as the "vault" handle —
    // getTokenBalance treats it specially. This keeps the read path API-only without decoding
    // Raydium's account layout.
    const value: PoolState = {
      baseVault: `dex:${poolAddress}:base`,
      quoteVault: `dex:${poolAddress}:quote`,
      baseDecimals: j.pair.baseToken.decimals ?? 6,
      quoteDecimals: j.pair.quoteToken.decimals ?? 9,
    };
    this.poolCache = { value, at: Date.now() };
    return value;
  }

  async getTokenBalance(account: string): Promise<{ uiAmount: string; amount: string; decimals: number }> {
    const ttl = this.opts.balanceCacheMs ?? 10_000;
    const cached = this.balanceCache.get(account);
    if (cached && Date.now() - cached.at < ttl) return cached.value;

    if (account.startsWith('dex:')) {
      // Special form: 'dex:<poolAddr>:base' | 'dex:<poolAddr>:quote'. Fetch from DexScreener.
      const parts = account.split(':');
      const poolAddr = parts[1]!;
      const side = parts[2]!;
      const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddr}`);
      if (!r.ok) throw new Error(`dexscreener pool ${r.status}`);
      const j = await r.json() as { pair?: { liquidity?: { base?: number; quote?: number }; baseToken: { decimals?: number }; quoteToken: { decimals?: number } } };
      if (!j.pair?.liquidity) throw new Error(`dexscreener liquidity missing for ${poolAddr}`);
      const ui = side === 'base' ? (j.pair.liquidity.base ?? 0) : (j.pair.liquidity.quote ?? 0);
      const decimals = side === 'base' ? (j.pair.baseToken.decimals ?? 6) : (j.pair.quoteToken.decimals ?? 9);
      const amount = String(Math.floor(ui * Math.pow(10, decimals)));
      const value = { uiAmount: String(ui), amount, decimals };
      this.balanceCache.set(account, { value, at: Date.now() });
      return value;
    }

    // Regular path: read token account via @solana/web3.js
    const pubkey = new PublicKey(account);
    const r = await this.opts.connection.getTokenAccountBalance(pubkey);
    const value = {
      uiAmount: r.value.uiAmountString ?? '0',
      amount: r.value.amount,
      decimals: r.value.decimals,
    };
    this.balanceCache.set(account, { value, at: Date.now() });
    return value;
  }

  async getWalletBalances(): Promise<{ bert: string; sol: string }> {
    const ttl = this.opts.balanceCacheMs ?? 10_000;
    if (this.walletCache && Date.now() - this.walletCache.at < ttl) return this.walletCache.value;
    if (!this.opts.hotWalletPubkey) {
      // No wallet configured — return zeros (Phase 1 observer mode).
      const value = { bert: '0', sol: '0' };
      this.walletCache = { value, at: Date.now() };
      return value;
    }
    const wallet = new PublicKey(this.opts.hotWalletPubkey);
    const [solLamports, splAccounts] = await Promise.all([
      this.opts.connection.getBalance(wallet),
      this.opts.connection.getParsedTokenAccountsByOwner(wallet, { mint: new PublicKey(this.opts.bertMint) }),
    ]);
    const sol = String(solLamports / 1e9);
    const bertUi = splAccounts.value[0]?.account.data.parsed?.info?.tokenAmount?.uiAmountString ?? '0';
    const value = { bert: bertUi, sol };
    this.walletCache = { value, at: Date.now() };
    return value;
  }
}
