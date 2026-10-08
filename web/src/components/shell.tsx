'use client';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Icon} from './icons';
import {PageExperience} from './page-experience';
export function Dialog({title,children,onClose}: {title:string;children:React.ReactNode;onClose:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);const titleId=useId();const [mounted,setMounted]=useState(false);
 useEffect(()=>setMounted(true),[]);
 useEffect(()=>{if(!mounted)return;const el=ref.current;if(el&&!el.open)el.showModal();return()=>el?.close()},[mounted]);
 if(!mounted)return null;
 return createPortal(<dialog ref={ref} className="dialog" aria-labelledby={titleId} onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose()}}><button className="icon-btn dialog-close" aria-label="Close dialog" onClick={onClose}><Icon name="close"/></button><div className="eyebrow">LEVERET</div><h2 id={titleId}>{title}</h2>{children}</dialog>,document.body);
}
export function Socials(){const [social,setSocial]=useState('');return <><div className="socials">{(['github','telegram','x'] as const).map(name=><button key={name} className="icon-btn" aria-label={name==='x'?'X':name==='github'?'GitHub':'Telegram'} onClick={()=>setSocial(name)}><Icon name={name}/></button>)}</div>{social&&<Dialog title="Coming soon" onClose={()=>setSocial('')}><p>Our {social==='x'?'X':social==='github'?'GitHub':'Telegram'} is on its way.</p><button className="btn dark" onClick={()=>setSocial('')}>Back to Leveret</button></Dialog>}</>}
export function Brand(){return <Link className="brand" href="/" aria-label="Leveret home"><img src="/brand/logo-transparent.png" width="48" height="32" alt=""/><span>Leveret</span></Link>}
export function Header({light=false}: {light?:boolean}){
 const path=usePathname();const [open,setOpen]=useState(false);const [scrolled,setScrolled]=useState(false);
 useEffect(()=>{const sync=()=>setScrolled(window.scrollY>35);sync();window.addEventListener('scroll',sync,{passive:true});return()=>window.removeEventListener('scroll',sync)},[]);
 useEffect(()=>setOpen(false),[path]);
 useEffect(()=>{const close=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false)};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close)},[]);
 return <><header className={`site-header persistent-nav ${light&&!scrolled?'light':''} ${scrolled?'is-scrolled':''}`}><Brand/><nav aria-label="Main navigation" className={open?'mobile-open':''}>{[['Markets','/markets/'],['Products','/products/'],['Agents','/agents/'],['Protocol','/protocol/']].map(([label,href])=><Link key={label} href={href} aria-current={path===href?'page':undefined} onClick={()=>setOpen(false)}>{label}</Link>)}</nav><div className="header-actions"><Socials/><Link className="btn small" href="/dashboard/">Launch app</Link><button className="icon-btn mobile-toggle" aria-label="Toggle menu" aria-expanded={open} onClick={()=>setOpen(!open)}><Icon name={open?'close':'menu'}/></button></div></header><div className="nav-clearance" aria-hidden="true"/></>;
}
export function Footer(){return <footer className="site-footer"><div><Brand/><p>Every price. One account.</p></div><nav aria-label="Footer navigation"><Link href="/markets/">Markets</Link><Link href="/products/">Products</Link><Link href="/agents/">Agents</Link><Link href="/protocol/">Protocol</Link></nav><div><Socials/><small>© 2026 Leveret · Built on Solana</small></div></footer>}
export function PageShell({children}: {children:React.ReactNode}){return <><Header/><PageExperience>{children}</PageExperience><Footer/></>}
