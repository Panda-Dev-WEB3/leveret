'use client';
import {useEffect,useRef,useState} from 'react';
import {usePathname} from 'next/navigation';
import {Icon} from './icons';

export function PageExperience({children}: {children:React.ReactNode}){
 const root=useRef<HTMLDivElement>(null);
 const dock=useRef<HTMLElement>(null);
 const path=usePathname();
 const [sections,setSections]=useState<{id:string;label:string}[]>([]);
 const [active,setActive]=useState(0);
 const [progress,setProgress]=useState(0);
 useEffect(()=>{
  const nav=dock.current;const link=nav?.querySelector<HTMLElement>('[aria-current]');if(!nav||!link)return;
  nav.scrollTo({left:Math.max(0,link.offsetLeft-(nav.clientWidth-link.offsetWidth)/2),behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
 },[active,sections]);
 useEffect(()=>{
  const host=root.current;if(!host)return;
  const blocks=Array.from(host.querySelectorAll<HTMLElement>('main > section'));
  const labels=path.startsWith('/products/')&&path!=='/products/'?['Overview','At a glance','Mechanics','Risk']:
   path==='/markets/'?['Overview','Markets','Your balance','Price & sessions']:
   path==='/products/'?['Overview','Families','Compare','Risk roots']:
   path==='/agents/'?['Overview','Your rulebook','Interface','Policy studio']:
   ['Overview','Principles','Engine','Architecture','Waterfall','Fees','Risk'];
  setSections(blocks.map((el,i)=>{el.id='chapter-'+i;return{id:el.id,label:labels[i]||'Explore'}}));
  const mq=window.matchMedia('(prefers-reduced-motion: reduce)');
  const targets=Array.from(host.querySelectorAll<HTMLElement>('main > section > *, .market-bento > *, .protocol-timeline > li, .program-directory > details, .instrument-editorial > article'));
  let observer:IntersectionObserver|undefined;
  if(!mq.matches){
   targets.forEach((el,i)=>{if(el.getBoundingClientRect().top>window.innerHeight){el.classList.add('scroll-reveal');el.style.setProperty('--reveal-delay',`${Math.min(i%3,2)*65}ms`)}});
   observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('is-revealed');observer?.unobserve(entry.target)}}),{threshold:.08,rootMargin:'0px 0px -35px 0px'});
   targets.forEach(el=>observer?.observe(el));
  }
  let frame=0;
  const update=()=>{
   frame=0;let current=0;
   blocks.forEach((el,i)=>{if(el.getBoundingClientRect().top<window.innerHeight*.4)current=i});
   setActive(current);
   const distance=document.documentElement.scrollHeight-window.innerHeight;
   setProgress(distance>0?Math.min(1,Math.max(0,window.scrollY/distance)):0);
  };
  const scroll=()=>{if(!frame)frame=requestAnimationFrame(update)};
  update();window.addEventListener('scroll',scroll,{passive:true});window.addEventListener('resize',scroll);
  const reduce=()=>targets.forEach(el=>el.classList.add('is-revealed'));mq.addEventListener('change',reduce);
  return()=>{observer?.disconnect();cancelAnimationFrame(frame);window.removeEventListener('scroll',scroll);window.removeEventListener('resize',scroll);mq.removeEventListener('change',reduce)};
 },[path]);
 return <div ref={root} className="page-experience">
  <div className="page-reading-progress" aria-hidden="true"><span style={{transform:`scaleX(${progress})`}}/></div>
  {children}
  {sections.length>0&&<nav ref={dock} className="chapter-navigation" aria-label="On this page"><Icon name="compass" size={17} botanical/>{sections.map((s,i)=><a key={s.id} href={'#'+s.id} aria-current={active===i?'location':undefined} onClick={e=>{e.preventDefault();document.getElementById(s.id)?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'})}}>{s.label}</a>)}</nav>}
 </div>;
}
