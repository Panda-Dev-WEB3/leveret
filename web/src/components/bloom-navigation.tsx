'use client';
import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState} from 'react';
import {usePathname,useRouter} from 'next/navigation';
import {useScroll} from '@/hooks/smooth-scroll/use-scroll';
import {BloomMark} from './bloom-ui';
import type {CSSProperties} from 'react';

const CLOSE_MS=920;
const OPEN_MS=1250;
const HOLD_MS=320;
const pageNames:Record<string,string>={'/':'Home','/markets/':'Markets','/products/':'Products','/agents/':'Agents','/protocol/':'Protocol','/products/core/':'Core','/products/stocks/':'Stocks','/products/small-caps/':'Small Caps','/products/squared/':'Squared','/products/factors/':'Factors','/products/tickets/':'Tickets','/products/twins/':'Twins'};
function pageName(href:string){
 const url=new URL(href,'https://leveret.local');
 if(url.pathname==='/dashboard/'){const views:Record<string,string>={trade:'Trading desk',portfolio:'Portfolio',orders:'Orders',agents:'Agent policies',risk:'Risk & receipts',settings:'Settings'};return views[url.searchParams.get('view')||'trade']||'Workspace'}
 return pageNames[url.pathname]||'Explore';
}

function releaseScroll(){
 document.documentElement.classList.remove('bloom-busy');
 document.body.classList.remove('bloom-busy');
 // Clear locks left by the previous homepage-only controller.
 for(const property of ['position','overflow','height'])document.documentElement.style.removeProperty(property);
 useScroll.getState().start();
 useScroll.getState().lenis?.start();
}

type SceneSignal={ready:()=>void;progress:(n:number)=>void;fallback:boolean};
const SceneContext=createContext<SceneSignal>({ready:()=>{},progress:()=>{},fallback:false});
export const useBloomEntrance=()=>useContext(SceneContext);

type Phase='loading'|'closing'|'waiting'|'opening'|'idle';
export function BloomNavigation({children}: {children:React.ReactNode}){
 const router=useRouter();const path=usePathname();
 const [phase,setPhase]=useState<Phase>('loading');const [hydrated,setHydrated]=useState(false);const [intro,setIntro]=useState(true);
 const [sceneReady,setSceneReady]=useState(false);const [sceneProgress,setSceneProgress]=useState(0);
 const [assetsReady,setAssetsReady]=useState(false);const [fallback,setFallback]=useState(false);
 const [nextPage,setNextPage]=useState(()=>pageName(path));const coveredAt=useRef(0);
 const phaseRef=useRef<Phase>('loading');const destination=useRef('');const previousPath=useRef(path);
 const timer=useRef<ReturnType<typeof setTimeout>|null>(null);const started=useRef(0);const mounted=useRef(false);
 const change=useCallback((next:Phase)=>{phaseRef.current=next;setPhase(next);if(next==='idle')setIntro(false)},[]);
 const reduced=()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches;
 const ready=useCallback(()=>{requestAnimationFrame(()=>requestAnimationFrame(()=>setSceneReady(true)))},[]);
 const progress=useCallback((n:number)=>setSceneProgress(Math.min(1,Math.max(0,n))),[]);
 const signal=useMemo(()=>({ready,progress,fallback}),[ready,progress,fallback]);
 const reveal=useCallback(()=>{
  if(timer.current)clearTimeout(timer.current);
  const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const delay=phaseRef.current==='waiting'&&!reduce?Math.max(0,HOLD_MS-(performance.now()-coveredAt.current)):0;
  timer.current=setTimeout(()=>{change('opening');timer.current=setTimeout(()=>change('idle'),reduce?40:OPEN_MS)},delay);
 },[change]);
 useEffect(()=>{
  mounted.current=true;setHydrated(true);started.current=performance.now();
  const imgs=Array.from(document.querySelectorAll<HTMLImageElement>('img')).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<window.innerHeight&&(el.loading!=='lazy'||el.complete)});
  const assetTimeout=setTimeout(()=>{if(mounted.current)setAssetsReady(true)},6000);
  Promise.allSettled([document.fonts.ready,...imgs.map(img=>img.complete&&img.naturalWidth>0?Promise.resolve():img.decode().catch(()=>{}))]).then(()=>{clearTimeout(assetTimeout);if(mounted.current)setAssetsReady(true)});
  return()=>{mounted.current=false;clearTimeout(assetTimeout);if(timer.current)clearTimeout(timer.current)};
 },[]);
 useEffect(()=>{
  if(phase!=='loading'||!assetsReady||path==='/'&&!sceneReady)return;
  const delay=Math.max(0,450-(performance.now()-started.current));const t=setTimeout(reveal,delay);
  return()=>clearTimeout(t);
 },[phase,assetsReady,path,sceneReady,reveal]);
 useEffect(()=>{
  if(phase!=='loading'&&phase!=='waiting'||path!=='/'||sceneReady)return;
  const t=setTimeout(()=>{setFallback(true);setSceneReady(true)},10000);return()=>clearTimeout(t);
 },[phase,path,sceneReady]);
 useEffect(()=>{
  const lock=phase!=='idle';
  if(lock){useScroll.getState().stop();document.documentElement.classList.add('bloom-busy');document.body.classList.add('bloom-busy')}
  else releaseScroll();
  return releaseScroll;
 },[phase]);
 useEffect(()=>{
  const navigate=(e:MouseEvent)=>{
   if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.altKey||e.shiftKey)return;
   const a=(e.target as Element)?.closest<HTMLAnchorElement>('a[href]');
   if(!a||a.hasAttribute('download')||a.target&&a.target!=='_self')return;
   const url=new URL(a.href,window.location.href);
   if(url.origin!==window.location.origin||url.pathname===window.location.pathname)return;
   if(phaseRef.current!=='idle'){e.preventDefault();return}
   e.preventDefault();e.stopPropagation();
   destination.current=url.pathname+url.search+url.hash;
   setNextPage(pageName(destination.current));
   if(url.pathname==='/'){setSceneReady(false);setSceneProgress(0);setFallback(false)}
   router.prefetch(destination.current);change('closing');
   timer.current=setTimeout(()=>{coveredAt.current=performance.now();change('waiting');router.push(destination.current)},reduced()?30:CLOSE_MS);
  };
  document.addEventListener('click',navigate,true);return()=>document.removeEventListener('click',navigate,true);
 },[router,change]);
 useEffect(()=>{
  if(previousPath.current===path)return;
  previousPath.current=path;
  if(phaseRef.current==='waiting'||phaseRef.current==='closing'){
   // Home's new WebGL instance is warmed behind the closed petals.
   if(path!=='/')requestAnimationFrame(()=>requestAnimationFrame(reveal));
  }else if(phaseRef.current==='idle'){destination.current=path;setNextPage(pageName(window.location.pathname+window.location.search));if(path==='/'){coveredAt.current=performance.now();setSceneReady(false);setSceneProgress(0);setFallback(false);change('waiting')}else reveal()};
 },[path,reveal,change]);
 useEffect(()=>{if(phase==='waiting'&&path==='/'&&sceneReady&&destination.current.split(/[?#]/)[0]===path)reveal()},[phase,path,sceneReady,reveal]);
 const initial=phase==='loading';const blocked=phase!=='idle';
 const value=(assetsReady?0.4:0)+(path==='/'?sceneProgress*0.55:assetsReady?0.55:0);
 const percent=assetsReady&&(path!=='/'||sceneReady)?100:Math.round(value*100);
 return <SceneContext.Provider value={signal}>
  <div className="bloom-site-content" inert={blocked&&hydrated} aria-hidden={blocked&&hydrated?true:undefined}>{children}</div>
  {blocked&&<div className={'bloom-overlay bloom-'+phase} role="status" aria-label={initial?'Loading Leveret':`Opening ${nextPage}`} style={{'--bloom-close-ms':`${CLOSE_MS}ms`,'--bloom-open-ms':`${OPEN_MS}ms`} as CSSProperties}>
   <div className="bloom-curtain"><BloomMark className="curtain-flower" petals={10}/></div>
   {!intro&&<div className="transition-page-medallion"><BloomMark className="transition-emblem" petals={10}/><div className="transition-name-circle"><span>EXPLORE</span><strong>{nextPage}</strong></div></div>}
   {intro&&<div className="bloom-preloader-card"><div className="preloader-emblem"><BloomMark/><img src="/brand/logo-transparent.png" alt=""/></div><span className="preloader-wordmark">Leveret</span><span className="preloader-tagline">EVERY PRICE. ONE ACCOUNT.</span><div className="preloader-progress" role="progressbar" aria-label="Website loading" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span style={{transform:`scaleX(${percent/100})`}}/></div><span className="preloader-caption">{percent===100?'A wider field awaits.':'Preparing your field.'}</span></div>}
  </div>}
  <noscript><style>{'.bloom-overlay{display:none!important}.petal-step-copy{opacity:1!important;transform:none!important}.petal-step-number .bloom-mark{opacity:1!important;transform:none!important}'}</style></noscript>
 </SceneContext.Provider>;
}
