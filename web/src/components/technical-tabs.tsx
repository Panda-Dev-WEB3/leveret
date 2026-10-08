'use client';
import {useId,useRef,useState} from 'react';
import {Icon,type IconName} from './icons';
export interface TechnicalTab {title:string;icon:IconName;summary:string;points:{label:string;body:string}[]}
export function TechnicalTabs({label,tabs}: {label:string;tabs:TechnicalTab[]}){
 const [active,setActive]=useState(0);const id=useId();const refs=useRef<(HTMLButtonElement|null)[]>([]);
 const choose=(i:number)=>{setActive(i);refs.current[i]?.focus()};
 return <div className="technical-tabs">
  <div role="tablist" aria-label={label} className="technical-tab-list">
   {tabs.map((t,i)=><button key={t.title} ref={el=>{refs.current[i]=el}} id={id+'-tab-'+i} role="tab" aria-selected={i===active} aria-controls={id+'-panel'} tabIndex={i===active?0:-1} onClick={()=>setActive(i)} onKeyDown={e=>{
    if(e.key==='ArrowRight'){e.preventDefault();choose((active+1)%tabs.length)}
    if(e.key==='ArrowLeft'){e.preventDefault();choose((active-1+tabs.length)%tabs.length)}
    if(e.key==='Home'){e.preventDefault();choose(0)}
    if(e.key==='End'){e.preventDefault();choose(tabs.length-1)}
   }}><Icon name={t.icon} size={19} botanical/>{t.title}</button>)}
  </div>
  <div id={id+'-panel'} role="tabpanel" aria-labelledby={id+'-tab-'+active} tabIndex={0} className="technical-panel" key={active}>
   <p className="technical-summary">{tabs[active].summary}</p>
   <div className="technical-points">{tabs[active].points.map(p=><article key={p.label}><h3>{p.label}</h3><p>{p.body}</p></article>)}</div>
  </div>
 </div>
}
