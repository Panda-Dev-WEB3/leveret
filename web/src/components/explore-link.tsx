'use client';
import {useScroll} from '@/hooks/smooth-scroll/use-scroll';
export function ExploreLink(){return <a className="text-link" href="#possibilities" onClick={event=>{event.preventDefault();const el=document.getElementById('possibilities');if(!el)return;const lenis=useScroll.getState().lenis;if(lenis)lenis.scrollTo(el,{offset:-20});else el.scrollIntoView({behavior:'smooth',block:'start'});}}>Explore the possibilities</a>}
