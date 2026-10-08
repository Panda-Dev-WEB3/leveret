'use client';
import Link from 'next/link';
import {useRef,useState} from 'react';
import {families} from '@/data/leveret';
import {Icon} from './icons';

export function ProductCarousel(){
 const track=useRef<HTMLDivElement>(null);
 const [active,setActive]=useState(0);
 const go=(index:number)=>{
  const el=track.current;if(!el)return;
  const next=Math.max(0,Math.min(families.length-1,index));
  el.scrollTo({left:next*el.clientWidth,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
 };
 return <section className="product-carousel section" aria-label="Explore the seven product families">
  <div className="section-intro carousel-intro"><div><div className="eyebrow">FIND YOUR EXPRESSION</div><h2>A different shape<br/><em>for every idea.</em></h2></div><div className="carousel-navigation"><span aria-live="polite">{String(active+1).padStart(2,'0')} <span>/ 07</span></span><button aria-label="Previous product family" disabled={active===0} onClick={()=>go(active-1)}><Icon name="chevron"/></button><button aria-label="Next product family" disabled={active===families.length-1} onClick={()=>go(active+1)}><Icon name="chevron"/></button></div></div>
  <div className="carousel-family-index" aria-label="Choose a product family">{families.map((f,i)=><button key={f.slug} aria-pressed={active===i} onClick={()=>go(i)}>{f.name}</button>)}</div>
  <div ref={track} className="product-carousel-track" tabIndex={0} aria-label="Product carousel; swipe or use left and right arrow keys" onScroll={e=>setActive(Math.round(e.currentTarget.scrollLeft/e.currentTarget.clientWidth))} onKeyDown={e=>{if(e.key==='ArrowRight'){e.preventDefault();go(active+1)}if(e.key==='ArrowLeft'){e.preventDefault();go(active-1)}if(e.key==='Home'){e.preventDefault();go(0)}if(e.key==='End'){e.preventDefault();go(families.length-1)}}}>
   {families.map((f,i)=><article className={'product-carousel-slide family-'+f.slug} key={f.slug} aria-label={f.name} aria-hidden={active!==i} inert={active!==i}>
    <div className="carousel-photo"><img src={f.slug==='core'?'/photos/golden-wildflower-meadow.webp':'/brand/'+f.asset.replace('.png','.webp')} alt={f.slug==='core'?'Sunlit wildflowers in the Leveret copper and gold palette':f.name+' Leveret artwork'} loading="lazy"/></div>
    <div className="carousel-copy"><span className="eyebrow">0{i+1} / {f.name.toUpperCase()}</span><h3>{f.name}</h3><p className="carousel-subtitle">{f.subtitle}</p><p>{f.description}</p><div className="carousel-facts"><div><span>Exposure</span><strong>{f.leverage}</strong></div><div><span>Fee framework</span><strong>{f.fee}</strong></div></div><Link className="btn dark" href={'/products/'+f.slug+'/'}>Explore {f.name}</Link></div>
   </article>)}
  </div>
 </section>
}
