'use client';
import {useEffect,useRef,useState} from 'react';
import {Icon} from './icons';

type Cue='hop'|'land';
const CONTROL='button,a[href],summary,[role="button"],input[type="submit"],input[type="button"],label:has(input[type="radio"]),label:has(input[type="checkbox"])';
const SOUND_KEY='leveret.interface-sounds';

export function ButtonFeedback(){
 const [enabled,setEnabled]=useState(true);const [ready,setReady]=useState(false);const [lastCue,setLastCue]=useState<Cue|null>(null);
 const enabledRef=useRef(true);const context=useRef<AudioContext|null>(null);const buffers=useRef<Partial<Record<Cue,AudioBuffer>>>({});
 const sources=useRef<Set<AudioBufferSourceNode>>(new Set());const fileBytes=useRef<Partial<Record<Cue,ArrayBuffer>>>({});
 const unlockRef=useRef<()=>Promise<void>>(async()=>{});const playRef=useRef<(cue:Cue)=>void>(()=>{});
 useEffect(()=>{
  let disposed=false;let lastHop=0;let activeHover:HTMLElement|null=null;const timers=new Set<ReturnType<typeof setTimeout>>();const animated=new Set<HTMLElement>();
  const mq=window.matchMedia('(prefers-reduced-motion: reduce)');
  try{const saved=localStorage.getItem(SOUND_KEY);if(saved==='off'){enabledRef.current=false;setEnabled(false)}}catch{}
  const load=async(cue:Cue)=>{try{const response=await fetch(cue==='hop'?'/audio/bunny-hop.wav':'/audio/bunny-land.wav');if(response.ok)fileBytes.current[cue]=await response.arrayBuffer()}catch{}};
  const files=Promise.all([load('hop'),load('land')]);
  let preparing:Promise<void>|null=null;
  const unlock=async()=>{
   if(disposed||!enabledRef.current)return;
   try{
    if(!context.current)context.current=new AudioContext();
    const ctx=context.current;
    // resume is called from the same trusted pointer/keyboard gesture as the button.
    const resumed=ctx.state==='suspended'?ctx.resume():Promise.resolve();
    if(!preparing)preparing=files.then(async()=>{for(const cue of ['hop','land'] as const){const bytes=fileBytes.current[cue];if(bytes)buffers.current[cue]=await ctx.decodeAudioData(bytes.slice(0))}});
    await Promise.all([resumed,preparing]);
    if(!disposed)setReady(ctx.state==='running'&&Boolean(buffers.current.hop&&buffers.current.land));
   }catch{}
  };
  unlockRef.current=unlock;
  const play=(cue:Cue)=>{
   const ctx=context.current;const buffer=buffers.current[cue];if(!enabledRef.current||!ctx||ctx.state!=='running'||!buffer||disposed)return;
   if(cue==='hop'&&performance.now()-lastHop<140)return;
   if(cue==='hop')lastHop=performance.now();
   if(sources.current.size>=4){const oldest=sources.current.values().next().value;if(oldest){oldest.stop();sources.current.delete(oldest)}}
   const source=ctx.createBufferSource();const gain=ctx.createGain();source.buffer=buffer;gain.gain.value=cue==='hop'?.35:.42;
   source.connect(gain);gain.connect(ctx.destination);sources.current.add(source);
   source.onended=()=>{sources.current.delete(source);source.disconnect();gain.disconnect()};source.start();setLastCue(cue);
  };
  playRef.current=play;
  const target=(event:Event)=>{
   const el=(event.target as Element)?.closest<HTMLElement>(CONTROL);
   return el&&!el.matches(':disabled,[aria-disabled="true"]')&&!el.closest('[inert]')?el:null;
  };
  const animate=(el:HTMLElement,kind:'hover'|'land')=>{
   if(mq.matches)return;
   el.classList.remove('bunny-hover','bunny-land');
   // Separate translate/scale properties preserve the petal nodes' positioning.
   void el.offsetWidth;el.classList.add('bunny-'+kind);animated.add(el);
   const timer=setTimeout(()=>{el.classList.remove('bunny-'+kind);animated.delete(el);timers.delete(timer)},kind==='hover'?560:430);timers.add(timer);
  };
  const enter=(event:PointerEvent)=>{
   if(event.pointerType==='touch')return;
   const el=target(event);if(!el||el===activeHover||el.contains(event.relatedTarget as Node|null))return;
   activeHover=el;if(animated.has(el)&&el.classList.contains('bunny-hover'))return;animate(el,'hover');play('hop');
  };
  const leave=(event:PointerEvent)=>{if(activeHover&&!activeHover.contains(event.relatedTarget as Node|null)){if(!animated.has(activeHover))activeHover.classList.remove('bunny-hover');activeHover=null}};
  const gesture=(event:Event)=>{if(!target(event)?.matches('.interface-sound-toggle'))void unlock()};
  const click=(event:MouseEvent)=>{const el=target(event);if(!el)return;animate(el,'land');if(!el.matches('.interface-sound-toggle'))void unlock().then(()=>play('land'))};
  document.addEventListener('pointerover',enter,true);document.addEventListener('pointerout',leave,true);
  document.addEventListener('pointerdown',gesture,true);document.addEventListener('keydown',gesture,true);document.addEventListener('click',click,true);
  return()=>{disposed=true;document.removeEventListener('pointerover',enter,true);document.removeEventListener('pointerout',leave,true);document.removeEventListener('pointerdown',gesture,true);document.removeEventListener('keydown',gesture,true);document.removeEventListener('click',click,true);timers.forEach(clearTimeout);animated.forEach(el=>el.classList.remove('bunny-hover','bunny-land'));sources.current.forEach(source=>source.stop());sources.current.clear();void context.current?.close();context.current=null;buffers.current={}};
 },[]);
 const toggle=()=>{
  if(enabledRef.current&&!ready){void unlockRef.current().then(()=>playRef.current('land'));return}
  const next=!enabledRef.current;enabledRef.current=next;setEnabled(next);try{localStorage.setItem(SOUND_KEY,next?'on':'off')}catch{}
  if(next)void unlockRef.current().then(()=>playRef.current('land'));else{sources.current.forEach(s=>s.stop());sources.current.clear()}
 };
 const label=!enabled?'Sound off':ready?'Sound on':'Enable sound';
 return <button className="interface-sound-toggle" aria-label={label} aria-pressed={enabled&&ready} title={label} onClick={toggle} data-audio-state={!enabled?'muted':ready?'ready':'awaiting-gesture'} data-last-cue={lastCue||undefined}><Icon name={enabled?'volume':'muted'} size={19} botanical/><span>{label}</span></button>;
}
