'use client';
import {useEffect,useState} from 'react';
import {LazyGrassField} from '@/components/scene/grass-field/lazy-grass-field';
import {useBloomEntrance} from './bloom-navigation';

export function HeroScene(){
 const [mode,setMode]=useState<'pending'|'live'|'still'>('pending');
 const [ready,setReady]=useState(false);const [unavailable,setUnavailable]=useState(false);const [gust,setGust]=useState(false);
 const entrance=useBloomEntrance();
 useEffect(()=>{
  const mq=window.matchMedia('(prefers-reduced-motion: reduce)');
  const sync=()=>{setMode(mq.matches?'still':'live');setReady(false);setUnavailable(false)};
  sync();mq.addEventListener('change',sync);return()=>mq.removeEventListener('change',sync);
 },[]);
 useEffect(()=>{if(ready&&mode==='live'&&!unavailable&&!entrance.fallback)entrance.ready()},[ready,mode,unavailable,entrance.ready,entrance.fallback]);
 useEffect(()=>{
  if(mode!=='still'&&!unavailable&&!entrance.fallback)return;
  let cancelled=false;const image=new Image();image.src='/brand/hero-landscape.webp';
  image.decode().catch(()=>{}).then(()=>{if(!cancelled)entrance.ready()});return()=>{cancelled=true};
 },[mode,unavailable,entrance.fallback,entrance.ready]);
 const live=mode==='live'&&!unavailable&&!entrance.fallback;
 return <>
  <div className="hero-background" style={{backgroundImage:'url(/brand/hero-landscape.webp)'}}/>
  <div className="interactive-hero-media hero-media-stack"><div className="hero-field-layer" style={{opacity:ready&&live?1:0}}>{mode==='live'&&!entrance.fallback&&<LazyGrassField className="hero-grass-canvas" gust={gust} onLoadProgress={entrance.progress} onReady={()=>setReady(true)} onUnavailable={()=>setUnavailable(true)}/>}</div></div>
  <div className="hero-interaction-bar"><span className="hero-field-label">Explore the field</span>{live&&ready&&<button className="breeze-button" onClick={()=>{setGust(false);requestAnimationFrame(()=>setGust(true))}}>Send a breeze</button>}<span className="hero-interaction-hint" aria-live="polite">{!live?'A moment in the meadow.':ready?'Move across the grass to leave a trail.':'Opening the meadow…'}</span></div>
 </>;
}
