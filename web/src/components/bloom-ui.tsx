import type {CSSProperties} from 'react';
export function BloomMark({className='',petals=8,active=-1}: {className?:string;petals?:number;active?:number}){
 return <svg className={'bloom-mark '+className} viewBox="0 0 200 200" fill="none" aria-hidden="true">{Array.from({length:petals},(_,i)=><g key={i} transform={`rotate(${i*360/petals} 100 100)`} className={active===i?'selected-petal':''} style={{'--petal-index':i} as CSSProperties}><path className="bloom-petal" d="M100 101C68 79 63 45 100 12C137 45 132 79 100 101Z"/><path className="petal-vein" d="M100 95V27M100 63 87 49M100 75 114 57"/></g>)}<circle className="bloom-heart" cx="100" cy="100" r="15"/><circle cx="100" cy="100" r="8" className="bloom-center"/></svg>;
}
