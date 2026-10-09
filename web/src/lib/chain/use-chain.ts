'use client';
// One hook for the dashboard: wallet connection, live market + account state
// (polled), and the signed actions. Disabled (reference mode) when no cluster
// is configured.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chainConfig } from './config.ts';
import { type AccountState, DELEGATE_SLOTS, LeveretClient, type LiveMarket, type LivePosition, type LiveTrigger } from './client.ts';
import type { Address } from '@solana/kit';

/** Dashboard family names → engine tool-mask bits. */
const TOOL_BIT: Record<string, number> = { Core: 0, Stocks: 1, 'Small Caps': 2, Squared: 3, Factors: 4, Tickets: 5, Twins: 6 };
import { type ConnectedWallet, type WalletChoice, listWallets, onWalletsChanged } from './wallets.ts';
import { onchainBySymbol } from '../../data/onchain-markets.ts';
import { powerBySymbol, ticketBySymbol } from '../../data/onchain-products.ts';
import * as pr from './products.ts';
import type { SideName } from './pdas.ts';

// the public devnet RPC rate-limits; poll it less often
const MARKETS_EVERY_MS = chainConfig?.cluster === 'devnet' ? 6_000 : 2_500;
const LAST_WALLET = 'leveret.wallet.v1';
const remember = (name: string | null) => {
  try {
    if (name) localStorage.setItem(LAST_WALLET, name);
    else localStorage.removeItem(LAST_WALLET);
  } catch {
    /* storage unavailable */
  }
};
const ACCOUNT_EVERY_MS = chainConfig?.cluster === 'devnet' ? 8_000 : 4_000;

export function useChain() {
  const client = useMemo(() => (chainConfig ? new LeveretClient(chainConfig) : null), []);
  const [wallets, setWallets] = useState<WalletChoice[]>([]);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [live, setLive] = useState<Map<string, LiveMarket>>(new Map());
  const [account, setAccount] = useState<AccountState | null>(null);
  const [products, setProducts] = useState<pr.ProductsState>({ power: new Map(), tickets: new Map() });
  const [holdings, setHoldings] = useState<pr.Holdings>({ power: [], tickets: [] });
  const [busy, setBusy] = useState('');
  const [feedError, setFeedError] = useState('');
  const walletRef = useRef<ConnectedWallet | null>(null);
  walletRef.current = wallet;

  useEffect(() => {
    const update = () => setWallets(listWallets(chainConfig));
    update();
    return onWalletsChanged(update);
  }, []);

  // reconnect the last wallet silently (no prompt) once it has registered
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current || walletRef.current) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_WALLET);
    } catch {
      return;
    }
    const choice = last ? wallets.find((w) => w.name === last) : undefined;
    if (!choice) return;
    tried.current = true;
    choice.connect(true).then(setWallet, () => remember(null));
  }, [wallets]);

  const loadMarkets = useCallback(async () => {
    if (!client) return;
    try {
      const [m, p] = await Promise.all([client.markets(), pr.productMarkets(client).catch(() => null)]);
      setLive(m);
      if (p) setProducts(p);
      setFeedError('');
    } catch (e) {
      setFeedError((e as Error).message);
    }
  }, [client]);

  const loadAccount = useCallback(async () => {
    const w = walletRef.current;
    if (!client || !w) {
      setHoldings({ power: [], tickets: [] });
      return setAccount(null);
    }
    try {
      const [a, h] = await Promise.all([client.account(w.address), pr.holdings(client, w.address)]);
      setAccount(a);
      setHoldings(h);
    } catch {
      /* keep the last good snapshot */
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    void loadMarkets();
    const id = setInterval(loadMarkets, MARKETS_EVERY_MS);
    return () => clearInterval(id);
  }, [client, loadMarkets]);

  useEffect(() => {
    if (!client || !wallet) return;
    void loadAccount();
    const id = setInterval(loadAccount, ACCOUNT_EVERY_MS);
    return () => clearInterval(id);
  }, [client, wallet, loadAccount]);

  const run = useCallback(
    async (label: string, build: (c: LeveretClient, w: ConnectedWallet) => Promise<string>) => {
      const w = walletRef.current;
      if (!client || !w) throw new Error('Connect a wallet first.');
      setBusy(label);
      try {
        const sig = await build(client, w);
        await Promise.all([loadAccount(), loadMarkets()]);
        return sig;
      } finally {
        setBusy('');
      }
    },
    [client, loadAccount, loadMarkets],
  );

  return {
    enabled: !!client,
    config: chainConfig,
    wallets,
    wallet,
    live,
    account,
    busy,
    feedError,
    products,
    holdings,
    isOnchain: (symbol: string) => !!client && (onchainBySymbol.has(symbol) || products.power.has(symbol) || products.tickets.has(symbol)),
    async connect(choice: WalletChoice) {
      const w = await choice.connect();
      setWallet(w);
      remember(choice.name);
    },
    async disconnect() {
      await walletRef.current?.disconnect();
      remember(null);
      setWallet(null);
      setAccount(null);
    },
    faucet: () =>
      run('Requesting test funds', async (c, w) => {
        const r = await fetch(`${c.cfg.quoteApi}/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: w.address }) });
        const body = (await r.json()) as { error?: string; usdc?: number };
        if (!r.ok) throw new Error(body.error ?? 'Faucet unavailable.');
        return `${body.usdc} test USDC`;
      }),
    deposit: (amount: number) => run('Depositing', async (c, w) => c.send(w, await c.depositIxs(w.address, amount))),
    withdraw: (amount: number) => run('Withdrawing', async (c, w) => c.send(w, await c.withdrawIxs(w.address, amount, account?.positions ?? []))),
    open: (symbol: string, a: { side: SideName; marginUsdc: number; leverage: number; slippagePct: number; isolated: boolean; tp?: number; sl?: number }) =>
      run('Opening position', async (c, w) => {
        const m = onchainBySymbol.get(symbol);
        if (!m) throw new Error(`${symbol} is not listed on-chain yet.`);
        const open = await c.openIxs(w.address, m, a);
        const sig = await c.send(w, open.ixs);
        if (a.tp || a.sl) {
          // a second, small transaction: the open already fills most of the size limit
          setBusy('Placing take profit / stop loss');
          await c.send(w, await c.placeTriggerIxs(w.address, m.id, a.side, open.size, { tp: a.tp, sl: a.sl, slippagePct: a.slippagePct }));
        }
        return sig;
      }),
    /** Authorize an agent policy on-chain as an engine delegate (never with withdraw rights). */
    authorizeAgent: (p: { signer: string; products: string[]; perOrder: number; budget: number; expiry: string }) =>
      run('Authorizing agent', async (c, w) => {
        const current = account?.delegates ?? [];
        const existing = current.find((d) => d.signer === p.signer);
        const used = new Set(current.map((d) => d.slot));
        const slot = existing?.slot ?? Array.from({ length: DELEGATE_SLOTS }, (_, i) => i).find((i) => !used.has(i));
        if (slot === undefined) throw new Error('All four delegate slots are in use. Revoke one first.');
        const toolMask = p.products.reduce((m, f) => (f in TOOL_BIT ? m | (1 << TOOL_BIT[f]) : m), 0);
        const expiry = Math.floor(new Date(p.expiry + 'T23:59:59Z').getTime() / 1000);
        return c.send(w, await c.setDelegateIxs(w.address, [{ slot, signer: p.signer as Address, toolMask, maxPerOrder: p.perOrder, dailyBudget: p.budget, expiry }]));
      }),
    revokeAgent: (signer: string) =>
      run('Revoking agent', async (c, w) => {
        const d = account?.delegates.find((x) => x.signer === signer);
        if (!d) throw new Error('That delegate is not authorized on-chain.');
        return c.send(w, await c.setDelegateIxs(w.address, [{ slot: d.slot }]));
      }),
    /** Kill switch: revoke every on-chain delegate in one transaction. */
    revokeAllAgents: () =>
      run('Revoking all agents', async (c, w) => {
        const all = account?.delegates ?? [];
        if (!all.length) return 'none';
        return c.send(w, await c.setDelegateIxs(w.address, all.map((d) => ({ slot: d.slot }))));
      }),
    cancelTrigger: (t: LiveTrigger) => run('Cancelling trigger', async (c, w) => c.send(w, await c.cancelTriggerIxs(w.address, t))),
    close: (p: LivePosition, slippagePct: number) => run('Closing position', async (c, w) => c.send(w, await c.closeIxs(w.address, p, slippagePct))),
    /** Squared long: buy PowerTokens from the QuoteAMM. */
    powerBuy: (symbol: string, usdc: number, slippagePct: number) =>
      run('Buying ' + symbol, async (c, w) => c.sendAll(w, (await pr.powerBuyIxs(c, w.address, need(powerBySymbol.get(symbol), symbol), usdc, slippagePct)).txs)),
    powerSell: (h: pr.PowerHolding, slippagePct: number) => run('Selling ' + h.product.symbol, async (c, w) => c.sendAll(w, await pr.powerSellIxs(c, w.address, h.product, h.tokens, slippagePct))),
    /** Squared short: mint against margin + proceeds, sell the tokens. */
    shortOpen: (symbol: string, marginUsdc: number, slippagePct: number) =>
      run('Opening ' + symbol + ' short', async (c, w) => {
        const o = await pr.shortOpenIxs(c, w.address, need(powerBySymbol.get(symbol), symbol), marginUsdc, slippagePct);
        if ((account?.usdcBalance ?? 0) < o.walletNeeds) throw new Error(`Opening this short moves ${o.walletNeeds.toFixed(2)} USDC from your wallet into the ShortVault (the sale returns most of it). Wallet: ${(account?.usdcBalance ?? 0).toFixed(2)} USDC.`);
        return c.sendAll(w, o.txs);
      }),
    shortClose: (h: pr.PowerHolding, slippagePct: number) =>
      run('Closing ' + h.product.symbol + ' short', async (c, w) => c.sendAll(w, await pr.shortCloseIxs(c, w.address, h.product, h, account?.usdcBalance ?? 0, slippagePct))),
    ticketBuy: (symbol: string, a: { side: SideName; budget: number; barrier: number; slippagePct: number }) =>
      run('Buying ticket', async (c, w) => c.sendAll(w, (await pr.ticketBuyIxs(c, w.address, need(ticketBySymbol.get(symbol), symbol), a)).txs)),
    ticketSell: (t: pr.LiveTicket, slippagePct: number) => run('Selling ticket back', async (c, w) => c.sendAll(w, await pr.ticketSellIxs(c, w.address, t, slippagePct))),
  };
}

export type Chain = ReturnType<typeof useChain>;

function need<T>(v: T | undefined, symbol: string): T {
  if (!v) throw new Error(`${symbol} is not listed on-chain yet.`);
  return v;
}
