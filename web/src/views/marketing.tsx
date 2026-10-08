import Link from 'next/link';
import {HomeView} from '@/views/home/home';
import {PageShell} from '@/components/shell';
import {Icon} from '@/components/icons';
import {MarketExplorer} from '@/components/market-explorer';
import {TechnicalTabs} from '@/components/technical-tabs';
import {ProductCarousel} from '@/components/product-carousel';
import {MarketBento,AgentRulebook,InstrumentMechanics} from '@/components/editorial-sections';
import {FlowExplorer,BalanceModes,ProductComparison,PolicyStudio,DesignBudget,FeeExplorer,RiskRoots,InstrumentSummary} from '@/components/interactive-sections';
import {ProtocolBloomPath,ProgramGarden} from '@/components/protocol-garden';
import {pagePhotos} from '@/data/photos';
import {families} from '@/data/leveret';
import {agentTechnical,familyTechnical,marketTechnical,protocolTechnical} from '@/data/technical';

function BotanicalHero({type,eyebrow,title,copy,action}: {type:'markets'|'products'|'agents'|'protocol';eyebrow:string;title:React.ReactNode;copy:string;action?:{href:string;label:string}}){
 const photo=pagePhotos[type];
 return <section className={`botanical-page-hero photographic-hero page-${type} section`}><div className="page-hero-copy"><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{copy}</p>{action?<Link className="btn dark" href={action.href}>{action.label}</Link>:<a className="page-explore-link text-link" href="#chapter-1">Explore {type}<Icon name="arrow" size={18}/></a>}</div><figure className="page-hero-art editorial-photo"><img src={photo.src} alt={photo.alt}/><figcaption className="art-caption"><span>LEVERET / {type.toUpperCase()}</span><a href={photo.source} target="_blank" rel="noreferrer">Photo: {photo.author}</a></figcaption></figure></section>
}
function TechnicalSection({eyebrow,title,children}: {eyebrow:string;title:React.ReactNode;children:React.ReactNode}){return <section className="technical-section section"><div className="technical-section-heading"><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div>{children}</section>}
function SpecNote(){return <p className="spec-note">Mechanics and design limits follow the supplied Leveret protocol specification. Current execution limits come from the verified on-chain configuration.</p>}
export function Home(){return <HomeView/>}

export function MarketsPage(){return <PageShell><main>
 <BotanicalHero type="markets" eyebrow="THE LEVERET MARKETPLACE" title={<>A broader<br/><em>horizon.</em></>} copy="Crypto, companies and new expressions of price. Follow the market that fits your conviction."/>
 <section className="section market-section"><MarketExplorer/></section>
 <section className="shared-balance-story section"><div className="restored-art-frame portrait-art"><img src="/brand/02-portrait-one-balance.webp" alt="Leveret — One USDC balance."/></div><div><div className="eyebrow">ONE SHARED FOUNDATION</div><h2>One balance.<br/><em>A wider reach.</em></h2><p>Deposit USDC once. Every product uses the shared margin ledger, while isolated mode can reserve collateral for an individual position.</p><p>Equity fills use verified bid and ask prices. Session flags, uncertainty bands and the current liquidity class determine whether a new entry can proceed.</p><BalanceModes/><Link className="btn dark" href="/dashboard/">Open the trading desk</Link></div></section>
 <TechnicalSection eyebrow="FROM REPORT TO PRICE" title={<>Know the price.<br/><em>Know its context.</em></>}><TechnicalTabs label="Market price information" tabs={marketTechnical}/><MarketBento/><SpecNote/></TechnicalSection>
 </main></PageShell>}

export function ProductsPage(){return <PageShell><main>
 <BotanicalHero type="products" eyebrow="THE WHOLE LANDSCAPE" title={<>Seven ways.<br/><em>One foundation.</em></>} copy="Different instruments for different ideas, connected by one Solana margin account."/>
 <ProductCarousel/>
 <TechnicalSection eyebrow="CHOOSE THE INSTRUMENT" title={<>The shape of<br/><em>your exposure.</em></>}><ProductComparison/></TechnicalSection>
 <section className="split-band section"><h2>One account.<br/><em>Separate risk roots.</em></h2><RiskRoots/><Link className="btn dark" href="/protocol/">Explore the risk architecture</Link></section>
 </main></PageShell>}

export function ProductDetail({slug}: {slug:string}){const f=families.find(x=>x.slug===slug)!;const tech=familyTechnical[slug];return <PageShell><main>
 <section className={'product-detail product-'+slug+' section'}><div><Link className="eyebrow" href="/products/">ALL PRODUCT FAMILIES</Link><h1>{f.name}<br/><em>{f.subtitle}</em></h1><p>{f.description}</p><div className="product-tags">{f.examples.map(s=><span key={s}>{s}</span>)}</div><Link className="btn dark" href={'/dashboard/?family='+encodeURIComponent(f.name)}>Explore {f.name}</Link></div><div className="detail-art-frame"><img src={slug==='core'?'/photos/golden-wildflower-meadow.webp':'/brand/'+f.asset.replace('.png','.webp')} alt={slug==='core'?'Golden wildflowers under warm copper light':f.name+' Leveret artwork'}/></div></section>
 <section className="detail-facts section"><InstrumentSummary slug={slug}/></section>
 <TechnicalSection eyebrow={f.name.toUpperCase()+' / MECHANICS'} title={<>Inside the<br/><em>instrument.</em></>}><p className="section-lead">{tech.intro}</p><FlowExplorer steps={tech.flow}/><InstrumentMechanics facts={tech.facts}/>{tech.table&&<div className="table-wrap product-spec-table"><table><thead><tr>{tech.table.headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{tech.table.rows.map(r=><tr key={r[0]}>{r.map((c,i)=><td key={i}>{c}</td>)}</tr>)}</tbody></table></div>}<SpecNote/></TechnicalSection>
 <section className="risk-block section"><Icon name="shield" size={36} botanical/><h2>Know the terrain.</h2><p>{f.risk}</p><p>Read the signed quote, current market state and fee estimate before signing.</p><Link className="btn outline" href="/protocol/">Explore protocol rules</Link></section>
 </main></PageShell>}

export function AgentsPage(){return <PageShell><main>
 <BotanicalHero type="agents" eyebrow="BUILT FOR PEOPLE AND AGENTS" title={<>Your rules.<br/><em>Their execution.</em></>} copy="A flowering network with clear boundaries: choose the products, define the budget and decide when the mandate ends." action={{href:'/dashboard/?view=agents',label:'Set your rulebook'}}/>
 <AgentRulebook/>
 <TechnicalSection eyebrow="MCP / x402 / RECEIPTS" title={<>A clear interface.<br/><em>A bounded mandate.</em></>}><TechnicalTabs label="Agent technical information" tabs={agentTechnical}/><FlowExplorer steps={['Read markets and request a quote','Check the delegate’s spending policy','Execute with a verified price and scoped signer','Verify the resulting receipt']}/></TechnicalSection>
 <section className="agent-technical section"><div><div className="eyebrow">PERMISSIONS THAT TRAVEL WITH THE ACCOUNT</div><h2>Give a rulebook.<br/><em>Keep ownership.</em></h2><p>Policy limits live with the margin account. A delegate’s scope is a set of product permissions, not a blanket right to move funds.</p><p>The withdrawal permission is separate and disabled by default. The frontend can prepare a policy; the owner’s wallet authorization establishes its authority.</p></div><PolicyStudio/></section>
 </main></PageShell>}

const programDetails:Record<string,string>={
 lvrt_oracle:'Checks signed report provenance, freshness, source agreement, session flags and uncertainty bands before a price can be used.',
 lvrt_engine:'Owns the USDC margin ledger, position updates and funding. Price bounds and exposure limits are checked with the trade.',
 lvrt_vault:'Tracks liquidity within product-family buckets. Twins use the Stocks backing path rather than a separate liquidity bucket.',
 lvrt_insurance:'Accounts for bucket insurance within the loss waterfall, after position margin and before the staked tranche and LLP NAV.',
 lvrt_power:'Defines normalized squared and ratio exposures, including carry and collateral rules for power positions.',
 lvrt_factor:'Maintains rules-based index weights and published methodology references. Stale constituents can pause an index.',
 lvrt_tickets:'Applies ticket financing and verifies knock-out barrier crossings against signed prices.',
 lvrt_twins:'Tracks the USDC buffer and backing position for wallet-held tracking tokens. A Twin is not a company share.',
 lvrt_gov:'Queues governance activations behind the 72-hour clock. Guardian authority can tighten risk immediately.',
 lvrt_fee_router:'Routes execution fees according to the published product-family fee framework.',
};
const rules=[['01','One collateral.','USDC is hard-coded as collateral. Changing collateral requires a program upgrade behind the public timelock.'],['02','Verified prices.','Fresh reports, source agreement and published price bands shape every executable quote.'],['03','A public clock.','Governance changes wait 72 hours. Emergency powers can tighten risk; loosening requires the timelock.'],['04','Separate risk buckets.','Each family has its own liquidity and insurance accounting. LLP NAV can decrease when traders win.'],['05','Visible trade-offs.','Carry, session changes, corporate actions and liquidation thresholds belong in the position view.'],['06','Bounded authority.','Delegates have product permissions, spending limits and expiry. Withdrawals stay off by default.']];
export function ProtocolPage(){return <PageShell><main>
 <BotanicalHero type="protocol" eyebrow="THE GROUND BENEATH EVERY TRADE" title={<>Clear rules.<br/><em>Visible boundaries.</em></>} copy="Verification at the roots. Separate risk chambers above. A margin engine designed around signed prices, scoped authority and transparent limits."/>
 <ProtocolBloomPath rules={rules}/>
 <TechnicalSection eyebrow="INSIDE THE ENGINE" title={<>Evidence first.<br/><em>Then execution.</em></>}><TechnicalTabs label="Protocol technical information" tabs={protocolTechnical}/><DesignBudget/><SpecNote/></TechnicalSection>
 <TechnicalSection eyebrow="A CONNECTED ARCHITECTURE" title={<>One ledger.<br/><em>Purpose-built programs.</em></>}><ProgramGarden programs={[
 {code:'lvrt_oracle',name:'Oracle',role:'Verify and aggregate reports',group:'Foundation'},
 {code:'lvrt_engine',name:'Engine',role:'Margin, positions and funding',group:'Foundation'},
 {code:'lvrt_vault',name:'Liquidity',role:'Family liquidity buckets',group:'Foundation'},
 {code:'lvrt_insurance',name:'Insurance',role:'Bucket insurance accounting',group:'Foundation'},
 {code:'lvrt_power',name:'Power',role:'Squared and ratio exposure',group:'Expressions'},
 {code:'lvrt_factor',name:'Factors',role:'Rules-based basket indices',group:'Expressions'},
 {code:'lvrt_tickets',name:'Tickets',role:'Barriers and financing',group:'Expressions'},
 {code:'lvrt_twins',name:'Twins',role:'Tracking-token backing',group:'Expressions'},
 {code:'lvrt_gov',name:'Governance',role:'Timelock and guardian controls',group:'Governance'},
 {code:'lvrt_fee_router',name:'Fees',role:'Published fee routing',group:'Foundation'},
 ].map(p=>({...p,detail:programDetails[p.code]}))}/><p className="section-lead architecture-services">The service layer in the build plan pairs Rust keepers with a Bun/Hono API, Postgres and Timescale, Redis, streamed account updates, and bundled liquidation/crank submission. Oracle, trigger, corporate-action, hedge and receipt services each have a defined job.</p></TechnicalSection>
 <section className="loss-waterfall section"><div className="eyebrow">THE LOSS WATERFALL</div><h2>Risk has<br/><em>a published order.</em></h2><FlowExplorer steps={['Position margin','Bucket insurance','Staked bucket tranche','Bucket LLP NAV','Auto-deleveraging']}/><p>A separate waterfall belongs to each bucket. Isolation limits spillover between families; it does not remove market losses. A depleted insurance fund can make its bucket reduce-only.</p></section>
 <section className="fee-section section"><div><div className="eyebrow">NO HIDDEN TERRAIN</div><h2>Costs, in<br/><em>plain sight.</em></h2></div><FeeExplorer/></section>
 <section className="risk-block section"><div className="eyebrow">BEFORE YOU TRADE</div><h2>Understand the exposure.</h2><p>Leverage amplifies losses. Small caps can halt and gap past a stop. Off-hours equity references use the last close. Squared products incur carry. Twins track through perps and are not shares. Liquidity-vault NAV can go down.</p><p>Use the current market state and limits before signing. The specified circuit breaker queues exceptional realized-profit withdrawals for one hour.</p><Link className="btn dark" href="/products/">Explore product risks</Link></section>
 </main></PageShell>}
