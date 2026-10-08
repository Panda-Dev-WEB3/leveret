'use client';
import {useEffect,useRef,useState} from 'react';
import type {CSSProperties} from 'react';
import {BloomMark} from './bloom-ui';
import {Icon} from './icons';

export function ProtocolBloomPath({rules}:{rules:string[][]}){
 const root=useRef<HTMLOListElement>(null);const [seen,setSeen]=useState<number[]>([]);const [active,setActive]=useState(-1);
 useEffect(()=>{
  const nodes=Array.from(root.current?.querySelectorAll<HTMLElement>('.petal-step')||[]);
  const mq=window.matchMedia('(prefers-reduced-motion: reduce)');
  if(mq.matches){setSeen(nodes.map((_,i)=>i));setActive(0);return}
  const observer=new IntersectionObserver(entries=>{entries.forEach(entry=>{if(entry.isIntersecting){const i=Number((entry.target as HTMLElement).dataset.step);setSeen(current=>current.includes(i)?current:[...current,i])}})},{rootMargin:'0px 0px -24% 0px',threshold:.15});
  nodes.forEach(n=>observer.observe(n));
  let frame=0;
  const track=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const target=window.innerHeight*.48;let next=-1;let distance=Infinity;nodes.forEach((node,i)=>{const r=node.getBoundingClientRect();if(r.top<window.innerHeight*.82&&r.bottom>0){const d=Math.abs(r.top+55-target);if(d<distance){distance=d;next=i}}});setActive(next)})};
  window.addEventListener('scroll',track,{passive:true});track();
  return()=>{observer.disconnect();window.removeEventListener('scroll',track);cancelAnimationFrame(frame)};
 },[]);
 return <section className="protocol-petal-path section"><div className="petal-path-intro"><span className="eyebrow">THE RULES THAT TRAVEL WITH YOU</span><h2>A clearer path.<br/><em>At every step.</em></h2><p>Price, authority, custody and risk each have a defined boundary.</p><div className="petal-path-seal"><BloomMark/><span>VERIFICATION<br/>BEFORE EXECUTION</span></div><span className="petal-scroll-note">Scroll to follow the roots<Icon name="chevron" size={16}/></span></div><ol ref={root} className="petal-path-trail">{rules.map(([n,title,body],i)=><li data-step={i} className={'petal-step'+(seen.includes(i)?' petal-seen':'')+(active===i?' petal-active':'')} key={n}><div className="petal-step-number"><BloomMark petals={6}/><span>{n}</span></div><div className="petal-step-copy"><span className="petal-step-label">BOUNDARY / {n}</span><h3>{title}</h3><p>{body}</p><span className="petal-step-line"/></div></li>)}</ol></section>;
}

type Program={code:string;name:string;role:string;detail:string;group:string};
const groups=['All programs','Foundation','Expressions','Governance'];
export function ProgramGarden({programs}:{programs:Program[]}){
 const [index,setIndex]=useState(1);const [group,setGroup]=useState('All programs');
 const allowed=programs.map((p,i)=>({p,i})).filter(({p})=>group==='All programs'||p.group===group);
 const selected=programs[index];
 const changeGroup=(next:string)=>{setGroup(next);if(next!=='All programs'&&selected.group!==next)setIndex(programs.findIndex(p=>p.group===next))};
 const move=(direction:number)=>{const current=allowed.findIndex(item=>item.i===index);setIndex(allowed[(current+direction+allowed.length)%allowed.length].i)};
 return <div className="program-garden"><div className="garden-toolbar"><div className="garden-groups" aria-label="Program responsibilities">{groups.map(g=><button key={g} aria-pressed={group===g} onClick={()=>changeGroup(g)}>{g}</button>)}</div><span>10 PROGRAMS · ONE CONNECTED SYSTEM</span></div><div className="garden-layout"><div className="program-bloom" aria-label="Explore the protocol programs"><BloomMark petals={10} active={index} className="program-flower"/><div className="garden-heart"><strong>USDC</strong></div>{programs.map((p,i)=>{const angle=(i*36-90)*Math.PI/180;return <button className={'program-petal-node'+(group!=='All programs'&&p.group!==group?' petal-muted':'')} aria-label={p.name+' — '+p.role} aria-pressed={index===i} aria-controls="program-focus" disabled={group!=='All programs'&&p.group!==group} key={p.code} style={{'--node-x':50+Math.cos(angle)*41+'%','--node-y':50+Math.sin(angle)*41+'%'} as CSSProperties} onClick={()=>setIndex(i)} onKeyDown={e=>{if(e.key==='ArrowRight'||e.key==='ArrowDown'){e.preventDefault();move(1)}if(e.key==='ArrowLeft'||e.key==='ArrowUp'){e.preventDefault();move(-1)}}}><span>{String(i+1).padStart(2,'0')}</span><strong>{p.name}</strong></button>})}<span className="garden-caption">SELECT A PETAL TO EXPLORE ITS ROLE</span></div><article id="program-focus" className="program-focus" aria-live="polite"><div className="program-focus-content" key={selected.code}><span className="eyebrow">{selected.group.toUpperCase()} / {String(index+1).padStart(2,'0')}</span><div className="program-focus-title"><h3>{selected.name}</h3><BloomMark petals={6}/></div><code>{selected.code}</code><h4>{selected.role}</h4><p>{selected.detail}</p><div className="program-root-note"><Icon name="network" size={22} botanical/><span>A defined responsibility.<br/>Connected through the shared account.</span></div></div><div className="garden-pagination"><span>{String(allowed.findIndex(p=>p.i===index)+1).padStart(2,'0')}<small> / {String(allowed.length).padStart(2,'0')}</small></span><div><button aria-label="Previous program" onClick={()=>move(-1)}><Icon name="chevron" size={20}/></button><button aria-label="Next program" onClick={()=>move(1)}><Icon name="chevron" size={20}/></button></div></div></article></div></div>;
}
