'use client';
import Link from 'next/link';
import {useId,useState} from 'react';
import {families,money} from '@/data/leveret';
import {Icon} from './icons';

const stepDetails:Record<string,string>={
 'Choose cross or isolated margin':'Cross margin shares the account’s available USDC. Isolated mode reserves collateral for an individual position.',
 'Verify fresh independent sources':'Core requires at least two agreeing fresh sources, within the specified 800 ms freshness window.',
 'Apply spread, skew and price bound':'Your limit price bounds the fill. The quoted spread and market skew are checked before a position is written.',
 'Write position and market shard':'The accepted trade updates the internal USDC ledger, position and one writable market shard atomically.',
 'Read the verified bid/ask report':'Equity fills use the bid or ask from a signed report, checked against a second source.',
 'Check the exchange session':'Session flags are checked against the exchange calendar before entry rules are applied.',
 'Apply the session’s leverage and spread':'Regular hours use full class limits. Pre, post and overnight sessions apply tighter leverage and wider spreads.',
 'Account for corporate actions':'Splits rescale size, entry and trigger prices together. Cash-dividend adjustments are logged per position.',
 'Combine at least three licensed feeds':'Independent licensed sources are aggregated within an attested confidential enclave.',
 'Reject outliers and publish a band':'The signed result includes a timestamp, uncertainty band, halt state and attestation reference.',
 'Apply the name’s liquidity class':'The class defines permitted leverage and spread according to underlying liquidity.',
 'Start at half caps and observe quality':'New names start at half caps; graduation requires 30 days of the specified LIVE state and band quality.',
 'Read the underlying oracle price':'A fresh underlying report supplies the price used to calculate the power index.',
 'Calculate the normalized price² index':'The index follows price squared with normalization. Its exposure changes as the underlying moves.',
 'Quote inside the session’s index band':'Session eligibility and the permitted index price band bound the executable quote.',
 'Accrue and display daily carry':'Daily carry reflects the gap between the mark and index, within the specified funding clamp.',
 'Score the eligible constituents':'The published factor methodology defines eligible assets and the rule used to score them.',
 'Apply weights and the market hedge':'The basket combines methodology weights with a market beta hedge.',
 'Publish the level and methodology hash':'The receipt includes the methodology hash, dataset root, weights root and snapshot timestamp.',
 'Rebalance on the rule’s cadence':'Each factor follows its published schedule; divisor adjustments preserve index continuity.',
 'Choose direction and barrier':'Choose a long or short view and a financing level that sets the knock-out boundary.',
 'Quote premium, spread and gap cost':'The quote shows the premium paid, which can be lost in full when the ticket knocks out.',
 'Roll financing at 00:00 UTC':'Financing moves the level over time, changing the barrier and effective leverage.',
 'Check crossings against verified reports':'A fresh verified report establishes the knock-out. A later valid report can prove a crossing during the lifetime.',
 'Deposit USDC into the Twin vault':'USDC supplies the transparent backing buffer for the tracking token.',
 'Open the matching 1× backing position':'The vault opens the corresponding perp exposure; funding uses the per-asset buffer.',
 'Mint the Token-2022 tracking token':'The wallet-held token tracks through backing exposure. It carries no company-share voting rights.',
 'Burn and redeem at the oracle price':'Redemption burns the token against the published verified price, subject to the fee framework.',
 'Read markets and request a quote':'Read-only market data and quotes are separate from execution authority.',
 'Check the delegate’s spending policy':'Product permissions, maximum per order, daily budget and expiry constrain the signer.',
 'Execute with a verified price and scoped signer':'Both a valid signed price report and authorized delegate are required to change a position.',
 'Verify the resulting receipt':'The executed event leaf and Merkle proof can be checked against the published hourly root.',
 'Position margin':'The affected position’s margin absorbs the loss first.',
 'Bucket insurance':'Insurance for the relevant family bucket is next in the published order.',
 'Staked bucket tranche':'The staked tranche for that bucket follows its insurance layer.',
 'Bucket LLP NAV':'The bucket’s liquidity-provider NAV can decrease when it absorbs losses.',
 'Auto-deleveraging':'ADL is the final specified stage after the earlier layers are exhausted.'
};
export function FlowExplorer({steps}: {steps:string[]}){
 const [active,setActive]=useState(0);const id=useId();
 return <div className="flow-explorer"><ol className="botanical-flow">{steps.map((s,i)=><li key={s} className={i===active?'active-step':''}><button aria-pressed={active===i} aria-controls={id} onClick={()=>setActive(i)}><span className="flow-node"><span>{String(i+1).padStart(2,'0')}</span></span><span className="flow-step-label">{s}</span><Icon name="arrow" size={18}/></button></li>)}</ol><div id={id} className="flow-explanation" aria-live="polite"><span className="eyebrow">STEP {String(active+1).padStart(2,'0')}</span><p key={active}>{stepDetails[steps[active]]||steps[active]}</p></div></div>;
}

export function BalanceModes(){
 const [mode,setMode]=useState('Cross');
 return <div className="balance-modes"><div className="segmented-control" aria-label="Margin accounting">{['Cross','Isolated'].map(m=><button key={m} aria-pressed={mode===m} onClick={()=>setMode(m)}>{m} margin</button>)}</div><p className="interaction-copy" key={mode}>{mode==='Cross'?'Available USDC supports positions across the shared margin account. Each instrument still follows its own risk limits.':'Reserve USDC for an individual position. Isolation changes the collateral allocation, while the instrument’s fees and market rules still apply.'}</p></div>;
}

export function InstrumentSummary({slug}: {slug:string}){
 const f=families.find(f=>f.slug===slug)!;
 const points=[['EXPOSURE',f.leverage,f.description],['FEES',f.fee,'Read the execution fee and any financing or carry in the quote before signing. '+f.risk],['COLLATERAL','One USDC balance.','Cross margin draws from the shared USDC ledger. Isolated mode reserves collateral for an individual position.']];
 return <>{points.map(([label,value,body])=><details key={label}><summary><span className="eyebrow">{label}</span><h3>{value}</h3><Icon name="plus" size={18}/></summary><p>{body}</p></details>)}</>;
}

const comparison=[
 ['A directional crypto view','Leverage, funding and margin'],['A directional equity or ETF view','Session tiers and corporate actions'],['A guarded small-company view','Price bands, depth and halts'],['Price² or a relative-price ratio','Normalization and daily carry'],['A rules-based hedged basket','Weights, rebalance and stale constituents'],['A direction with a knock-out barrier','Premium, financing and barrier crossings'],['Wallet-held 1× stock tracking','Backing position, buffer and holding costs']
];
export function ProductComparison(){
 const [active,setActive]=useState(0);const f=families[active];
 return <div className="product-comparison"><div className="comparison-selector" aria-label="Compare product families">{families.map((f,i)=><button key={f.slug} aria-pressed={i===active} onClick={()=>setActive(i)}><span>0{i+1}</span>{f.name}<Icon name="arrow" size={19}/></button>)}</div><div className="comparison-detail" key={f.slug}><div className="eyebrow">{f.name.toUpperCase()} / EXPOSURE</div><h3>{comparison[active][0]}</h3><div className="comparison-measures"><div><span>Exposure</span><strong>{f.leverage}</strong></div><div><span>Fee framework</span><strong>{f.fee}</strong></div></div><span className="eyebrow">WHAT TO WATCH</span><p>{comparison[active][1]}. {f.risk}</p><Link className="text-link" href={'/products/'+f.slug+'/'}>Inside {f.name}<Icon name="arrow" size={18}/></Link></div></div>;
}

export function PolicyStudio(){
 const [selected,setSelected]=useState(['core','stocks']);const [perOrder,setPerOrder]=useState(250);const [daily,setDaily]=useState(1000);
 const policy={products:selected,max_per_order:perOrder,daily_budget:daily,withdraw:false,expiry:'owner-defined'};
 return <div className="policy-studio"><div className="studio-controls"><div className="eyebrow">SHAPE THE MANDATE</div><fieldset><legend>Product permissions</legend><div className="studio-permissions">{families.map(f=><label key={f.slug}><input type="checkbox" checked={selected.includes(f.slug)} onChange={()=>setSelected(s=>s.includes(f.slug)?s.filter(x=>x!==f.slug):[...s,f.slug])}/><span>{f.name}</span></label>)}</div></fieldset><label className="studio-range"><span>Maximum per order<strong>${money(perOrder)}</strong></span><input aria-label="Policy maximum per order" type="range" min={50} max={Math.min(2000,daily)} step={50} value={perOrder} onChange={e=>setPerOrder(Number(e.target.value))}/></label><label className="studio-range"><span>Daily budget<strong>${money(daily)}</strong></span><input aria-label="Policy daily budget" type="range" min={250} max={10000} step={250} value={daily} onChange={e=>{const n=Number(e.target.value);setDaily(n);setPerOrder(p=>Math.min(p,n))}}/></label><span className="policy-withdraw"><Icon name="shield" size={17} botanical/>Withdrawal authority stays off.</span></div><div className="code-panel"><span>LEVERET / DELEGATE POLICY</span><pre aria-label="Policy preview">{JSON.stringify(policy,null,2)}</pre><small>Choose your limits here. Wallet authorization establishes the delegate’s authority.</small><Link className="text-link" href="/dashboard/?view=agents">Open agent policies<Icon name="arrow" size={18}/></Link></div></div>;
}

const budgetNotes=[['≤ 300k CU','Specified trade design budget','Includes verification for the open/close path. This is a specification target, rather than a measured performance result.'],['≤ 14 accounts','Specified account footprint','The trade carries the report and signature check, then updates the margin ledger, position and selected market shard.'],['8 shards','Default state distribution','The margin account’s hash selects a writable market shard. Changing the default count follows the timelock.']];
export function DesignBudget(){return <div className="design-budget-strip">{budgetNotes.map(([value,label,body])=><details key={value}><summary><strong>{value}</strong><span>{label}</span><Icon name="plus" size={17}/></summary><p>{body}</p></details>)}</div>}

export function FeeExplorer(){
 const [active,setActive]=useState(0);const f=families[active];
 return <div className="fee-explorer"><div className="fee-family-list" aria-label="Fee family">{families.map((f,i)=><button key={f.slug} aria-pressed={i===active} onClick={()=>setActive(i)}>{f.name}</button>)}</div><div className="fee-spotlight" key={f.slug}><span className="eyebrow">{f.name.toUpperCase()} / FEE FRAMEWORK</span><strong>{f.fee}</strong><p>{f.risk}</p><Link className="text-link" href={'/products/'+f.slug+'/'}>View the full mechanics<Icon name="arrow" size={18}/></Link></div></div>;
}

export function RiskRoots(){
 const [active,setActive]=useState(0);const risks=[['Family buckets','Each family has its own liquidity and insurance accounting. Twins use the Stocks backing path.'],['Shared collateral','One USDC margin account connects the instruments. A shared balance does not remove each position’s fees, carry or session limits.'],['Published waterfall','Position margin, bucket insurance, the staked tranche, LLP NAV and ADL absorb losses in the specified order.']];
 return <div className="risk-root-selector"><div aria-label="Risk architecture">{risks.map(([label],i)=><button key={label} aria-pressed={active===i} onClick={()=>setActive(i)}><Icon name={i===0?'factors':i===1?'wallet':'waterfall'} size={22} botanical/>{label}</button>)}</div><p className="interaction-copy" key={active}>{risks[active][1]}</p></div>;
}
