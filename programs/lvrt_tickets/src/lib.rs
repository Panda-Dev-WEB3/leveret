//! lvrt_tickets — knock-out tickets (Backend §9).
//!
//! Long: V = max(0, S − F)·r, knocked out when S ≤ F; short mirrored.
//! Leverage = S / |S − F|. The loss can never exceed the ticket price: no
//! margin calls, no liquidation. F rolls daily at 00:00 UTC at a rate locked
//! per ticket; F on any day is derived from (f_initial, rate, days) so a
//! knock-out can be proven against the barrier *as of the report's day*.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use lvrt_common::{
    assert_upgrade_authority, hash, ix_sysvar,
    lvrt_math::{notional, tickets as tk, BPS},
    seeds,
    sigverify::{verified_messages, PriceMsg},
    MathResultExt, PriceStatus, Session, Side, USDC_MINT,
};
use lvrt_oracle::{PriceState, SignerKey};

declare_id!("38GVDZJaTDb28E8uwcYt23TjfdKESci4i7t1ywbQJVnM");

/// Pre-audit caps (USDC).
pub const PRE_AUDIT_TICKET_CAP: u64 = 10_000 * 1_000_000;
pub const PRE_AUDIT_BUCKET_CAP: u64 = 1_000_000 * 1_000_000;

#[error_code]
pub enum TicketError {
    #[msg("Signer is not the timelock authority")]
    NotAuthority,
    #[msg("Wrong price account")]
    WrongPriceState,
    #[msg("Price must be LIVE and fresh")]
    PriceNotLive,
    #[msg("Barrier too close to spot")]
    TooClose,
    #[msg("Price above max_price")]
    Slippage,
    #[msg("Ticket or bucket cap exceeded")]
    Cap,
    #[msg("Stress budget exceeded: a 15% gap would cost > 25% of the bucket")]
    StressBudget,
    #[msg("Sell-back is paused off-hours")]
    OffHours,
    #[msg("Barrier not crossed by the evidence")]
    NotCrossed,
    #[msg("Evidence is outside the ticket's life")]
    BadEvidence,
    #[msg("Ticket already knocked out; call knock_out")]
    KnockedOut,
    #[msg("Wrong gift secret")]
    BadSecret,
    #[msg("Market paused")]
    Paused,
    #[msg("Invalid parameters")]
    InvalidParams,
}

#[account]
#[derive(InitSpace)]
pub struct TicketsConfig {
    pub authority: Pubkey,
    pub guardian: Pubkey,
    /// TICKETS bucket liquidity held by this program until lvrt_vault
    /// settlement is wired.
    pub vault: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TicketMarket {
    pub market_id: u32,
    pub price_state: Pubkey,
    pub fresh_ms: i64,
    /// Annual rates, RATE_SCALE.
    pub base_rate: i64,
    pub spread_long: i64,
    pub spread_short: i64,
    /// Ticket spread charged at purchase (15–50 bps of notional).
    pub spread_bps: u16,
    /// Half-spread applied to S for S_ask / S_bid.
    pub half_spread_bps: u16,
    pub gap_premium_bps: u16,
    pub gap_premium_off_hours_bps: u16,
    /// |net exposure| ≤ net_cap_bps × bucket assets.
    pub net_cap_bps: u16,
    pub gross_cap: u64,
    pub net_exposure: i64,
    pub gross_exposure: u64,
    /// Σ 15%-gap stress losses of live tickets.
    pub stress_total: u64,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Ticket {
    pub owner: Pubkey,
    pub market_id: u32,
    pub side: Side,
    /// Underlying units per ticket (BASE_SCALE).
    pub r: u64,
    pub f_initial: i64,
    /// Locked annual rate, RATE_SCALE (may be negative for shorts).
    pub rate: i64,
    pub issued_at: i64,
    pub notional: u64,
    pub stress: u64,
    pub gift_hash: [u8; 32],
    pub nonce: u64,
    pub bump: u8,
}

impl Ticket {
    /// Barrier on UTC day `day` (lazy roll from the issue day).
    pub fn barrier_on(&self, day: i64) -> Result<i64> {
        let d = (day - self.issued_at.div_euclid(86_400)).max(0) as u32;
        tk::roll_financing(self.f_initial, self.rate as i128, d).m()
    }
    pub fn barrier_now(&self, now: i64) -> Result<i64> {
        self.barrier_on(now.div_euclid(86_400))
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct TicketMarketParams {
    pub market_id: u32,
    pub fresh_ms: i64,
    pub base_rate: i64,
    pub spread_long: i64,
    pub spread_short: i64,
    pub spread_bps: u16,
    pub half_spread_bps: u16,
    pub gap_premium_bps: u16,
    pub gap_premium_off_hours_bps: u16,
    pub net_cap_bps: u16,
    pub gross_cap: u64,
}

#[event]
pub struct TicketEvent {
    pub ticket: Pubkey,
    pub kind: u8, // 0 buy, 1 sell, 2 knock-out, 3 transfer
    pub owner: Pubkey,
    pub price: u64,
    pub spot: i64,
    pub barrier: i64,
}

fn exposure_remove(m: &mut TicketMarket, t: &Ticket) {
    let signed = match t.side {
        Side::Long => t.notional as i64,
        Side::Short => -(t.notional as i64),
    };
    m.net_exposure -= signed;
    m.gross_exposure = m.gross_exposure.saturating_sub(t.notional);
    m.stress_total = m.stress_total.saturating_sub(t.stress);
}

#[program]
pub mod lvrt_tickets {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey, guardian: Pubkey) -> Result<()> {
        assert_upgrade_authority(&ctx.accounts.program, &ctx.accounts.program_data, &ctx.accounts.payer.key())?;
        let c = &mut ctx.accounts.config;
        c.authority = authority;
        c.guardian = guardian;
        c.vault = ctx.accounts.vault.key();
        c.bump = ctx.bumps.config;
        c.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn create_ticket_market(ctx: Context<CreateTicketMarket>, p: TicketMarketParams) -> Result<()> {
        require!(p.spread_bps as i64 >= tk::SPREAD_MIN_BPS && p.spread_bps as i64 <= tk::SPREAD_MAX_BPS, TicketError::InvalidParams);
        let m = &mut ctx.accounts.market;
        m.market_id = p.market_id;
        m.price_state = ctx.accounts.price_state.key();
        m.fresh_ms = p.fresh_ms;
        m.base_rate = p.base_rate;
        m.spread_long = p.spread_long;
        m.spread_short = p.spread_short;
        m.spread_bps = p.spread_bps;
        m.half_spread_bps = p.half_spread_bps;
        m.gap_premium_bps = p.gap_premium_bps;
        m.gap_premium_off_hours_bps = p.gap_premium_off_hours_bps;
        m.net_cap_bps = p.net_cap_bps;
        m.gross_cap = p.gross_cap.min(PRE_AUDIT_BUCKET_CAP);
        m.bump = ctx.bumps.market;
        Ok(())
    }

    pub fn buy(mut ctx: Context<Buy>, nonce: u64, side: Side, r: u64, barrier: i64, max_price: u64) -> Result<()> {
        let clock = Clock::get()?;
        let now_ms = clock.unix_timestamp * 1_000 + 999;
        let a = &mut ctx.accounts;
        let m = &mut a.market;
        let ps = &a.price_state;
        require!(!m.paused, TicketError::Paused);
        require!(ps.status == PriceStatus::Live && now_ms - ps.ts_ms <= m.fresh_ms, TicketError::PriceNotLive);
        require!(ps.session != Session::Closed, TicketError::OffHours);
        let s = ps.mid;
        require!(!tk::is_knocked_out(side.math(), s, barrier), TicketError::TooClose);
        require!(tk::distance_ok(s, barrier, !ps.session.is_off_hours()), TicketError::TooClose);

        let n = notional(r as i64, s).m()?.unsigned_abs();
        require!(n <= PRE_AUDIT_TICKET_CAP, TicketError::Cap);
        let gap_bps = if ps.session.is_off_hours() { m.gap_premium_off_hours_bps } else { m.gap_premium_bps } as i64;
        let gap_premium = (n as i128 * gap_bps as i128 / BPS as i128) as i64;
        let price = tk::ticket_price(side.math(), s, barrier, r as i64, m.half_spread_bps as i64, m.spread_bps as i64, gap_premium).m()? as u64;
        require!(price <= max_price, TicketError::Slippage);

        // bucket limits and the 15% stress budget
        let bucket_assets = a.vault.amount as i128;
        let signed = match side {
            Side::Long => n as i64,
            Side::Short => -(n as i64),
        };
        let net = m.net_exposure + signed;
        require!((net.unsigned_abs() as i128) * BPS as i128 <= m.net_cap_bps as i128 * bucket_assets, TicketError::Cap);
        require!(m.gross_exposure + n <= m.gross_cap, TicketError::Cap);
        let stress = tk::stress_loss(side.math(), s, barrier, r as i64, tk::STRESS_GAP_BPS).m()?.max(0) as u64;
        require!(
            ((m.stress_total + stress) as i128) * BPS as i128 <= tk::STRESS_MAX_LOSS_BPS as i128 * (bucket_assets + price as i128),
            TicketError::StressBudget
        );

        token_interface::transfer_checked(
            CpiContext::new(
                a.token_program.key(),
                TransferChecked {
                    from: a.buyer_usdc.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.vault.to_account_info(),
                    authority: a.buyer.to_account_info(),
                },
            ),
            price,
            a.usdc_mint.decimals,
        )?;

        m.net_exposure = net;
        m.gross_exposure += n;
        m.stress_total += stress;
        let t = &mut a.ticket;
        t.owner = a.buyer.key();
        t.market_id = m.market_id;
        t.side = side;
        t.r = r;
        t.f_initial = barrier;
        t.rate = tk::ticket_rate(side.math(), m.base_rate as i128, m.spread_long as i128, m.spread_short as i128) as i64;
        t.issued_at = clock.unix_timestamp;
        t.notional = n;
        t.stress = stress;
        t.nonce = nonce;
        t.bump = ctx.bumps.ticket;
        emit!(TicketEvent { ticket: t.key(), kind: 0, owner: t.owner, price, spot: s, barrier });
        Ok(())
    }

    /// Sell back at V(S_bid), session only.
    pub fn sell_back(mut ctx: Context<SellBack>, min_out: u64) -> Result<()> {
        let clock = Clock::get()?;
        let now_ms = clock.unix_timestamp * 1_000 + 999;
        let a = &mut ctx.accounts;
        let ps = &a.price_state;
        require!(ps.session == Session::Regular, TicketError::OffHours);
        require!(ps.status == PriceStatus::Live && now_ms - ps.ts_ms <= a.market.fresh_ms, TicketError::PriceNotLive);
        let t = &a.ticket;
        let f = t.barrier_now(clock.unix_timestamp)?;
        require!(!tk::is_knocked_out(t.side.math(), ps.mid, f), TicketError::KnockedOut);
        let adj = ps.mid as i128 * a.market.half_spread_bps as i128 / BPS as i128;
        let s_bid = match t.side {
            Side::Long => ps.mid - adj as i64,
            Side::Short => ps.mid + adj as i64,
        };
        let out = tk::ticket_value(t.side.math(), s_bid, f, t.r as i64).m()?.max(0) as u64;
        require!(out >= min_out, TicketError::Slippage);
        let bump = a.config.vault_bump;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.vault.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.owner_usdc.to_account_info(),
                    authority: a.vault.to_account_info(),
                },
                &[&[seeds::CUSTODY, &[bump]]],
            ),
            out,
            a.usdc_mint.decimals,
        )?;
        exposure_remove(&mut a.market, &a.ticket);
        emit!(TicketEvent { ticket: a.ticket.key(), kind: 1, owner: a.ticket.owner, price: out, spot: ps.mid, barrier: f });
        Ok(())
    }

    /// Permissionless. Evidence is either the current PriceState (fresh) or
    /// any Ed25519-signed `PriceMsg` from a registered oracle signer, inside
    /// the ticket's life, that crosses the barrier as of its own day — so a
    /// missed report can't keep a ticket alive.
    /// `remaining_accounts[0]` (optional): the signer's `SignerKey`.
    pub fn knock_out<'info>(ctx: Context<'info, KnockOut<'info>>) -> Result<()> {
        let clock = Clock::get()?;
        let a = &ctx.accounts;
        let t = &a.ticket;
        let now_ms = clock.unix_timestamp * 1_000 + 999;

        let (s, ts_ms) = if let Some(key_ai) = ctx.remaining_accounts.first() {
            let key: Account<SignerKey> = Account::try_from(key_ai)?;
            require!(key.active, TicketError::BadEvidence);
            let msgs = verified_messages(&a.instructions.to_account_info())?;
            let sm = msgs.iter().find(|m| m.signer == key.pubkey).ok_or(TicketError::BadEvidence)?;
            let m = PriceMsg::decode(&sm.message)?;
            require!(m.market_id == t.market_id, TicketError::BadEvidence);
            (m.mid, m.ts_ms)
        } else {
            let ps = &a.price_state;
            require!(matches!(ps.status, PriceStatus::Live | PriceStatus::Wide), TicketError::PriceNotLive);
            require!(now_ms - ps.ts_ms <= a.market.fresh_ms, TicketError::PriceNotLive);
            (ps.mid, ps.ts_ms)
        };
        require!(ts_ms >= t.issued_at * 1_000 && ts_ms <= now_ms, TicketError::BadEvidence);
        let f = t.barrier_on(ts_ms.div_euclid(86_400_000))?;
        require!(tk::is_knocked_out(t.side.math(), s, f), TicketError::NotCrossed);

        let key = a.ticket.key();
        let owner = a.ticket.owner;
        exposure_remove(&mut ctx.accounts.market, &ctx.accounts.ticket);
        emit!(TicketEvent { ticket: key, kind: 2, owner, price: 0, spot: s, barrier: f });
        Ok(())
    }

    pub fn transfer(ctx: Context<OwnerTicket>, new_owner: Pubkey) -> Result<()> {
        ctx.accounts.ticket.owner = new_owner;
        ctx.accounts.ticket.gift_hash = [0; 32];
        Ok(())
    }

    /// Gift link: anyone presenting `secret` with sha256(secret) == hash claims it.
    pub fn create_gift(ctx: Context<OwnerTicket>, secret_hash: [u8; 32]) -> Result<()> {
        ctx.accounts.ticket.gift_hash = secret_hash;
        Ok(())
    }

    pub fn claim_gift(ctx: Context<ClaimGift>, secret: Vec<u8>) -> Result<()> {
        let t = &mut ctx.accounts.ticket;
        require!(t.gift_hash != [0; 32] && hash(&secret).to_bytes() == t.gift_hash, TicketError::BadSecret);
        t.owner = ctx.accounts.claimer.key();
        t.gift_hash = [0; 32];
        Ok(())
    }

    /// TODO(tickets): splits — F / k and r × k at the effective time
    /// (f_initial / k keeps the lazy roll exact).
    pub fn apply_split(_ctx: Context<OwnerTicket>) -> Result<()> {
        err!(TicketError::InvalidParams)
    }
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + TicketsConfig::INIT_SPACE, seeds = [seeds::CONFIG], bump)]
    pub config: Box<Account<'info, TicketsConfig>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Self-owned PDA token account (authority = itself).
    #[account(
        init, payer = payer, seeds = [seeds::CUSTODY], bump,
        token::mint = usdc_mint, token::authority = vault, token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: this program.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    /// CHECK: checked in `assert_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(p: TicketMarketParams)]
pub struct CreateTicketMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ TicketError::NotAuthority)]
    pub config: Account<'info, TicketsConfig>,
    #[account(init, payer = payer, space = 8 + TicketMarket::INIT_SPACE, seeds = [seeds::MARKET, &p.market_id.to_le_bytes()], bump)]
    pub market: Account<'info, TicketMarket>,
    #[account(
        seeds = [seeds::PRICE, &p.market_id.to_le_bytes()],
        bump = price_state.bump,
        seeds::program = lvrt_oracle::ID,
    )]
    pub price_state: Account<'info, PriceState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, TicketsConfig>>,
    #[account(mut, seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, TicketMarket>>,
    #[account(address = market.price_state @ TicketError::WrongPriceState)]
    pub price_state: Box<Account<'info, PriceState>>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Ticket::INIT_SPACE,
        seeds = [seeds::TICKET, buyer.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint, token::authority = buyer)]
    pub buyer_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.vault)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SellBack<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, TicketsConfig>>,
    #[account(mut, seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, TicketMarket>>,
    #[account(address = market.price_state @ TicketError::WrongPriceState)]
    pub price_state: Box<Account<'info, PriceState>>,
    #[account(mut, close = owner, has_one = owner, constraint = ticket.market_id == market.market_id @ TicketError::InvalidParams)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint)]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.vault)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct KnockOut<'info> {
    #[account(mut, seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, TicketMarket>>,
    #[account(address = market.price_state @ TicketError::WrongPriceState)]
    pub price_state: Box<Account<'info, PriceState>>,
    #[account(mut, close = owner, constraint = ticket.market_id == market.market_id @ TicketError::InvalidParams)]
    pub ticket: Box<Account<'info, Ticket>>,
    /// CHECK: rent refund to the ticket owner.
    #[account(mut, address = ticket.owner)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: address-checked instructions sysvar.
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OwnerTicket<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub ticket: Account<'info, Ticket>,
}

#[derive(Accounts)]
pub struct ClaimGift<'info> {
    pub claimer: Signer<'info>,
    #[account(mut)]
    pub ticket: Account<'info, Ticket>,
}
