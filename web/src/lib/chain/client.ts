// Reads and writes against the Leveret programs for the dashboard.
// Prices: signed quotes from the quote API (what a trade embeds) and the
// on-chain PriceState (what the programs last accepted).
import {
  type Address,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import * as eng from '../../generated/lvrt_engine/index.ts';
import * as orc from '../../generated/lvrt_oracle/index.ts';
import { CUSTODY_COUNT, ONCHAIN_MARKETS, type OnchainMarket, SHARDS, onchainBySymbol } from '../../data/onchain-markets.ts';
import { ENGINE, IX_SYSVAR, type SideName, TOKEN_PROGRAM, engine, oracle, shardFor } from './pdas.ts';
import { type QuoteJson, ed25519Instruction, fromQuoteJson } from './price-msg.ts';
import { createRpc } from './rpc.ts';
import type { ChainConfig } from './config.ts';
import type { ConnectedWallet } from './wallets.ts';

export const PRICE = 1e8;
export const USDC_UNIT = 1e6;
export const BASE_UNIT = 1e6;

export interface LiveMarket {
  symbol: string;
  id: number;
  /** Latest signed quote (the price a trade would carry). */
  quote?: { mid: number; bid: number; ask: number; tsMs: number };
  /** What the programs last accepted. */
  onchain?: { mid: number; status: string; session: string; lastClose: number; tsMs: number };
  market?: { maxLevX100: number; mmBps: number; feeTenthBps: number; reduceOnly: boolean };
  funding?: { oiLong: number; oiShort: number; rate: number };
}

export interface LivePosition {
  address: Address;
  symbol: string;
  marketId: number;
  side: SideName;
  size: number;
  entry: number;
  margin: number;
  isolated: boolean;
  openedAt: number;
}

export type TriggerKindName = 'TakeProfit' | 'StopLoss';

export interface LiveTrigger {
  address: Address;
  symbol: string;
  marketId: number;
  side: SideName;
  kind: TriggerKindName;
  triggerPx: number;
  size: number;
  expiry: number;
}

/** An engine delegate slot (MarginAccount.delegates, §11). */
export interface LiveDelegate {
  slot: number;
  signer: Address;
  /** bit 0 core, 1 stocks, 2 smallcap, 3 squared, 4 factors, 5 tickets, 6 twins, 7 withdraw */
  toolMask: number;
  maxPerOrder: number;
  dailyBudget: number;
  spentToday: number;
  expiry: number;
}

export const DELEGATE_SLOTS = 4;
const ZERO = '11111111111111111111111111111111' as Address;

export interface AccountState {
  marginExists: boolean;
  collateral: number;
  imReserved: number;
  queuedProfit: number;
  usdcBalance: number;
  solBalance: number;
  positions: LivePosition[];
  triggers: LiveTrigger[];
  delegates: LiveDelegate[];
}

const STATUS = ['Live', 'Wide', 'Halted', 'CaPending', 'Delisted'];
const SESSIONS = ['Regular', 'Pre', 'Post', 'Overnight', 'Closed'];

export class LeveretClient {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly cfg: ChainConfig;
  constructor(cfg: ChainConfig) {
    this.cfg = cfg;
    this.rpc = createRpc(cfg.rpcUrl);
  }

  // ------------------------------------------------------------------ reads

  async quotes(): Promise<Map<number, QuoteJson>> {
    const r = await fetch(`${this.cfg.quoteApi}/quotes`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`quote API ${r.status}`);
    const { quotes } = (await r.json()) as { quotes: QuoteJson[] };
    return new Map(quotes.map((q) => [q.marketId, q]));
  }

  async quote(marketId: number): Promise<QuoteJson> {
    const r = await fetch(`${this.cfg.quoteApi}/quote/${marketId}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('No signed quote is available for this market right now.');
    return (await r.json()) as QuoteJson;
  }

  async markets(): Promise<Map<string, LiveMarket>> {
    const out = new Map<string, LiveMarket>();
    const [prices, mkts, funds] = await Promise.all([
      orc.fetchAllMaybePriceState(this.rpc, await Promise.all(ONCHAIN_MARKETS.map((m) => oracle.price(m.id)))),
      eng.fetchAllMaybeMarket(this.rpc, await Promise.all(ONCHAIN_MARKETS.map((m) => engine.market(m.id)))),
      eng.fetchAllMaybeFundingState(this.rpc, await Promise.all(ONCHAIN_MARKETS.map((m) => engine.funding(m.id)))),
    ]);
    let quotes = new Map<number, QuoteJson>();
    try {
      quotes = await this.quotes();
    } catch {
      /* quote API down: on-chain state only */
    }
    ONCHAIN_MARKETS.forEach((m, i) => {
      const p = prices[i];
      const k = mkts[i];
      const f = funds[i];
      const q = quotes.get(m.id);
      out.set(m.symbol, {
        symbol: m.symbol,
        id: m.id,
        quote: q ? { mid: Number(q.mid) / PRICE, bid: Number(q.bid) / PRICE, ask: Number(q.ask) / PRICE, tsMs: Number(q.tsMs) } : undefined,
        onchain: p.exists
          ? { mid: Number(p.data.mid) / PRICE, status: STATUS[p.data.status] ?? '?', session: SESSIONS[p.data.session] ?? '?', lastClose: Number(p.data.lastClose) / PRICE, tsMs: Number(p.data.tsMs) }
          : undefined,
        market: k.exists ? { maxLevX100: k.data.risk.maxLevX100, mmBps: k.data.risk.mmBps, feeTenthBps: k.data.risk.feeTenthBps, reduceOnly: k.data.reduceOnly } : undefined,
        funding: f.exists ? { oiLong: Number(f.data.oiLong) / BASE_UNIT, oiShort: Number(f.data.oiShort) / BASE_UNIT, rate: Number(f.data.rate) / 1e12 } : undefined,
      });
    });
    return out;
  }

  async account(owner: Address): Promise<AccountState> {
    const margin = await engine.margin(owner);
    const [m, ata, sol] = await Promise.all([
      eng.fetchMaybeMarginAccount(this.rpc, margin),
      findAssociatedTokenPda({ owner, mint: this.cfg.usdcMint, tokenProgram: TOKEN_PROGRAM }),
      this.rpc.getBalance(owner, { commitment: 'confirmed' }).send(),
    ]);
    let usdcBalance = 0;
    try {
      const bal = await this.rpc.getTokenAccountBalance(ata[0], { commitment: 'confirmed' }).send();
      usdcBalance = Number(bal.value.amount) / USDC_UNIT;
    } catch {
      /* no token account yet */
    }
    const [positions, triggers] = m.exists ? await Promise.all([this.positions(margin), this.triggers(margin)]) : [[], []];
    return {
      marginExists: m.exists,
      collateral: m.exists ? Number(m.data.collateral) / USDC_UNIT : 0,
      imReserved: m.exists ? Number(m.data.imReserved) / USDC_UNIT : 0,
      queuedProfit: m.exists ? Number(m.data.queuedProfit) / USDC_UNIT : 0,
      usdcBalance,
      solBalance: Number(sol.value) / 1e9,
      positions,
      triggers,
      delegates: m.exists
        ? m.data.delegates
            .map((d, slot) => ({
              slot,
              signer: d.signer,
              toolMask: d.toolMask,
              maxPerOrder: Number(d.maxPerOrder) / USDC_UNIT,
              dailyBudget: Number(d.dailyBudget) / USDC_UNIT,
              spentToday: Number(d.spentToday) / USDC_UNIT,
              expiry: Number(d.expiry),
            }))
            .filter((d) => d.signer !== ZERO)
        : [],
    };
  }

  private async positions(margin: Address): Promise<LivePosition[]> {
    const b58 = getBase58Decoder();
    const res = await this.rpc
      .getProgramAccounts(ENGINE, {
        encoding: 'base64',
        commitment: 'confirmed',
        filters: [
          { memcmp: { offset: 0n, bytes: b58.decode(eng.POSITION_DISCRIMINATOR) as never, encoding: 'base58' } },
          { memcmp: { offset: 8n, bytes: margin as never, encoding: 'base58' } },
        ],
      })
      .send();
    const dec = eng.getPositionDecoder();
    const bySymbol = new Map(ONCHAIN_MARKETS.map((x) => [x.id, x.symbol]));
    return res
      .map(({ pubkey, account }) => {
        const p = dec.decode(getBase64Encoder().encode(account.data[0]));
        return {
          address: pubkey,
          symbol: bySymbol.get(p.marketId) ?? `#${p.marketId}`,
          marketId: p.marketId,
          side: (p.side === eng.Side.Long ? 'Long' : 'Short') as SideName,
          size: Number(p.size) / BASE_UNIT,
          entry: Number(p.entryPx) / PRICE,
          margin: Number(p.isolatedMargin > 0n ? p.isolatedMargin : p.imReserved) / USDC_UNIT,
          isolated: p.isolatedMargin > 0n,
          openedAt: Number(p.openedAt),
        };
      })
      .filter((p) => p.size > 0);
  }

  /** Open TP/SL triggers of a margin account (the `margin` field sits at offset 8). */
  async triggers(margin: Address): Promise<LiveTrigger[]> {
    const b58 = getBase58Decoder();
    const res = await this.rpc
      .getProgramAccounts(ENGINE, {
        encoding: 'base64',
        commitment: 'confirmed',
        filters: [
          { memcmp: { offset: 0n, bytes: b58.decode(eng.TRIGGER_DISCRIMINATOR) as never, encoding: 'base58' } },
          { memcmp: { offset: 8n, bytes: margin as never, encoding: 'base58' } },
        ],
      })
      .send();
    const dec = eng.getTriggerDecoder();
    const bySymbol = new Map(ONCHAIN_MARKETS.map((x) => [x.id, x.symbol]));
    return res.map(({ pubkey, account }) => {
      const t = dec.decode(getBase64Encoder().encode(account.data[0]));
      return {
        address: pubkey,
        symbol: bySymbol.get(t.marketId) ?? `#${t.marketId}`,
        marketId: t.marketId,
        side: (t.side === eng.Side.Long ? 'Long' : 'Short') as SideName,
        kind: (t.kind === eng.TriggerKind.TakeProfit ? 'TakeProfit' : 'StopLoss') as TriggerKindName,
        triggerPx: Number(t.triggerPx) / PRICE,
        size: Number(t.size) / BASE_UNIT,
        expiry: Number(t.expiry),
      };
    });
  }

  /** TP / SL triggers for a position; executed by any keeper through the same fill path. */
  async placeTriggerIxs(owner: Address, marketId: number, side: SideName, sizeBase: number, t: { tp?: number; sl?: number; slippagePct: number }) {
    const signer = createNoopSigner(owner);
    const margin = await engine.margin(owner);
    const out: Instruction[] = [];
    const base = BigInt(Date.now()) * 1000n;
    let i = 0n;
    for (const [kind, px] of [[eng.TriggerKind.TakeProfit, t.tp], [eng.TriggerKind.StopLoss, t.sl]] as const) {
      if (!px) continue;
      const nonce = base + i++;
      out.push(
        eng.getPlaceTriggerInstruction({
          signer,
          margin,
          trigger: await engine.trigger(margin, nonce),
          nonce,
          marketId,
          side: side === 'Long' ? eng.Side.Long : eng.Side.Short,
          kind,
          triggerPx: BigInt(Math.round(px * PRICE)),
          size: BigInt(Math.round(sizeBase * BASE_UNIT)),
          expiry: BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400),
          maxSlippageBps: Math.round(t.slippagePct * 100),
          keeperBounty: BigInt(0.1 * USDC_UNIT),
        }),
      );
    }
    return out;
  }

  /** Write one delegate slot. A zeroed delegate revokes it. Withdraw (bit 7) is never set here. */
  async setDelegateIxs(owner: Address, slots: { slot: number; signer?: Address; toolMask?: number; maxPerOrder?: number; dailyBudget?: number; expiry?: number }[]): Promise<Instruction[]> {
    const signer = createNoopSigner(owner);
    const margin = await engine.margin(owner);
    return slots.map((d) =>
      eng.getSetDelegateInstruction({
        owner: signer,
        margin,
        slot: d.slot,
        delegate: {
          signer: d.signer ?? ZERO,
          toolMask: (d.toolMask ?? 0) & 0x7f,
          maxPerOrder: BigInt(Math.round((d.maxPerOrder ?? 0) * USDC_UNIT)),
          dailyBudget: BigInt(Math.round((d.dailyBudget ?? 0) * USDC_UNIT)),
          spentToday: 0n,
          day: 0,
          expiry: BigInt(d.expiry ?? 0),
        },
      }),
    );
  }

  async cancelTriggerIxs(owner: Address, t: LiveTrigger): Promise<Instruction[]> {
    return [eng.getCancelTriggerInstruction({ signer: createNoopSigner(owner), margin: await engine.margin(owner), trigger: t.address, owner })];
  }

  // -------------------------------------------------------------- builders

  /** `[Ed25519 verify] [lvrt_oracle::post_prices]` for a fresh signed quote. */
  async priceIxs(marketId: number): Promise<{ ixs: Instruction[]; quote: QuoteJson }> {
    const quote = await this.quote(marketId);
    const sigs = fromQuoteJson(quote);
    const post = orc.getPostPricesInstruction({ feed: await oracle.feed(marketId), priceState: await oracle.price(marketId), calendar: await oracle.calendar(), instructions: IX_SYSVAR });
    const keys = await Promise.all(sigs.map(async (s) => ({ address: await oracle.signerKey(s.signer), role: AccountRole.READONLY })));
    return { ixs: [ed25519Instruction(sigs), { ...post, accounts: [...post.accounts, ...keys] }], quote };
  }

  private async ensureMargin(owner: Address, signer: ReturnType<typeof createNoopSigner>): Promise<Instruction[]> {
    const margin = await engine.margin(owner);
    const m = await eng.fetchMaybeMarginAccount(this.rpc, margin);
    return m.exists ? [] : [eng.getCreateMarginAccountInstruction({ owner: signer, margin, subId: 0 })];
  }

  async depositIxs(owner: Address, amountUsdc: number): Promise<Instruction[]> {
    const signer = createNoopSigner(owner);
    const margin = await engine.margin(owner);
    const [ata] = await findAssociatedTokenPda({ owner, mint: this.cfg.usdcMint, tokenProgram: TOKEN_PROGRAM });
    return [
      ...(await this.ensureMargin(owner, signer)),
      eng.getDepositInstruction({
        owner: signer,
        margin,
        config: await engine.config(),
        usdcMint: this.cfg.usdcMint,
        ownerUsdc: ata,
        custody: await engine.custody(shardFor(margin, CUSTODY_COUNT)),
        tokenProgram: TOKEN_PROGRAM,
        amount: BigInt(Math.round(amountUsdc * USDC_UNIT)),
      }),
    ];
  }

  private async healthAccounts(positions: LivePosition[]) {
    const out = [];
    for (const p of positions) {
      out.push(
        { address: p.address, role: AccountRole.READONLY },
        { address: await engine.market(p.marketId), role: AccountRole.READONLY },
        { address: await engine.funding(p.marketId), role: AccountRole.READONLY },
        { address: await oracle.price(p.marketId), role: AccountRole.READONLY },
      );
    }
    return out;
  }

  async withdrawIxs(owner: Address, amountUsdc: number, positions: LivePosition[]): Promise<Instruction[]> {
    const signer = createNoopSigner(owner);
    const margin = await engine.margin(owner);
    const custodyIndex = shardFor(margin, CUSTODY_COUNT);
    const [ata] = await findAssociatedTokenPda({ owner, mint: this.cfg.usdcMint, tokenProgram: TOKEN_PROGRAM });
    const ix = eng.getWithdrawInstruction({
      signer,
      margin,
      config: await engine.config(),
      engineSigner: await engine.signer(),
      usdcMint: this.cfg.usdcMint,
      ownerUsdc: ata,
      custody: await engine.custody(custodyIndex),
      tokenProgram: TOKEN_PROGRAM,
      amount: BigInt(Math.round(amountUsdc * USDC_UNIT)),
      custodyIndex,
    });
    // fresh prices for every open position so the health check reads them
    const prices = (await Promise.all([...new Set(positions.map((p) => p.marketId))].map((id) => this.priceIxs(id)))).flatMap((x) => x.ixs);
    return [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner, mint: this.cfg.usdcMint }),
      ...prices,
      { ...ix, accounts: [...ix.accounts, ...(await this.healthAccounts(positions))] },
    ];
  }

  async openIxs(owner: Address, m: OnchainMarket, a: { side: SideName; marginUsdc: number; leverage: number; slippagePct: number; isolated: boolean }) {
    const signer = createNoopSigner(owner);
    const margin = await engine.margin(owner);
    const { ixs, quote } = await this.priceIxs(m.id);
    const ref = Number(a.side === 'Long' ? quote.ask : quote.bid) / PRICE;
    const notional = a.marginUsdc * a.leverage;
    const size = BigInt(Math.floor((notional / (Number(quote.mid) / PRICE)) * BASE_UNIT));
    const bound = a.side === 'Long' ? ref * (1 + a.slippagePct / 100) : ref * (1 - a.slippagePct / 100);
    const open = eng.getOpenPositionInstruction({
      signer,
      config: await engine.config(),
      margin,
      market: await engine.market(m.id),
      fundingState: await engine.funding(m.id),
      priceState: await oracle.price(m.id),
      shard: await engine.shard(m.id, shardFor(margin, SHARDS)),
      position: await engine.position(margin, m.id, a.side),
      side: a.side === 'Long' ? eng.Side.Long : eng.Side.Short,
      size,
      priceBound: BigInt(Math.round(bound * PRICE)),
      leverageX100: Math.round(a.leverage * 100),
      isolatedMargin: a.isolated ? BigInt(Math.round(a.marginUsdc * USDC_UNIT)) : 0n,
    });
    return { ixs: [...ixs, open], quote, size: Number(size) / BASE_UNIT };
  }

  async closeIxs(owner: Address, p: LivePosition, slippagePct: number) {
    const signer = createNoopSigner(owner);
    const margin = await engine.margin(owner);
    const { ixs, quote } = await this.priceIxs(p.marketId);
    // closing a long sells at the bid; a short buys back at the ask
    const ref = Number(p.side === 'Long' ? quote.bid : quote.ask) / PRICE;
    const bound = p.side === 'Long' ? ref * (1 - slippagePct / 100) : ref * (1 + slippagePct / 100);
    const close = eng.getClosePositionInstruction({
      signer,
      margin,
      market: await engine.market(p.marketId),
      fundingState: await engine.funding(p.marketId),
      priceState: await oracle.price(p.marketId),
      shard: await engine.shard(p.marketId, shardFor(margin, SHARDS)),
      position: p.address,
      owner,
      size: 0n,
      priceBound: BigInt(Math.round(bound * PRICE)),
    });
    return [...ixs, close];
  }

  // ------------------------------------------------------------------ send

  /** Send consecutive transactions (one wallet approval each); returns the last signature. */
  async sendAll(wallet: ConnectedWallet, txs: Instruction[][]): Promise<string> {
    let sig = '';
    for (const ixs of txs) sig = await this.send(wallet, ixs);
    return sig;
  }

  /** Sign with the connected wallet, send, and wait for confirmation. */
  async send(wallet: ConnectedWallet, ixs: Instruction[]): Promise<string> {
    const { value: blockhash } = await this.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    let wire: string;
    let signature: string;
    if (wallet.keypair) {
      const tx = await signTransactionMessageWithSigners(
        pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(wallet.keypair!, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
          (m) => appendTransactionMessageInstructions(ixs.map((ix) => withSigner(ix, wallet.keypair!)), m),
        ),
      );
      wire = getBase64EncodedWireTransaction(tx);
      signature = getSignatureFromTransaction(tx);
    } else {
      const unsigned = compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(createNoopSigner(wallet.address), m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
          (m) => appendTransactionMessageInstructions(ixs, m),
        ),
      );
      const signed = await wallet.signTransaction(new Uint8Array(getTransactionEncoder().encode(unsigned)));
      wire = btoa(String.fromCharCode(...signed));
      // the fee payer's signature is the first one in the wire format
      signature = getBase58Decoder().decode(signed.slice(1, 65));
    }
    const sim = await this.rpc.simulateTransaction(wire as never, { encoding: 'base64', commitment: 'confirmed', replaceRecentBlockhash: false, sigVerify: false }).send();
    if (sim.value.err) throw new Error(explain(sim.value.logs ?? [], sim.value.err));
    await this.rpc.sendTransaction(wire as never, { encoding: 'base64', skipPreflight: true }).send();
    for (let i = 0; i < 60; i++) {
      const { value } = await this.rpc.getSignatureStatuses([signature as never]).send();
      const s = value[0];
      if (s?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(s.err, big)}`);
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return signature;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Transaction not confirmed in time; it may still land. Refresh in a moment.');
  }
}

const big = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** The burner signs as the owner/signer accounts that are its own address. */
function withSigner(ix: Instruction, kp: { address: Address }): Instruction {
  return {
    ...ix,
    accounts: ix.accounts?.map((a) => ('signer' in a ? { ...a, signer: kp } : a.address === kp.address && (a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER) ? { ...a, signer: kp } : a)) as Instruction['accounts'],
  };
}

/** Turn program logs into a readable reason (Anchor error message if present). */
export function explain(logs: readonly string[], err: unknown): string {
  const anchor = logs.map((l) => /Error Message: (.*)$/.exec(l)?.[1]).find(Boolean);
  if (anchor) return anchor;
  const custom = logs.find((l) => l.includes('failed:'));
  return custom ?? `Transaction would fail: ${JSON.stringify(err, big)}`;
}

export const isOnchain = (symbol: string) => onchainBySymbol.has(symbol);
