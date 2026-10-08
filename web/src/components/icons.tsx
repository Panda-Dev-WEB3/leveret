import type { CSSProperties } from 'react';
export type IconName = 'github'|'telegram'|'x'|'grid'|'chart'|'wallet'|'bot'|'shield'|'search'|'close'|'menu'|'star'|'settings'|'copy'|'check'|'plus'|'download'|'clock'|'layers'|'log'|'sun'|'chevron'|'pause'|'play'|'arrow'|'core'|'stocks'|'smallCaps'|'squared'|'factors'|'tickets'|'twins'|'trade'|'portfolio'|'orders'|'oracle'|'network'|'receipt'|'governance'|'waterfall'|'permission'|'volume'|'muted'|'compass'|'budget'|'expiry'|'custody';
export const familyIcons:Record<string,IconName>={Core:'core',Stocks:'stocks','Small Caps':'smallCaps',Squared:'squared',Factors:'factors',Tickets:'tickets',Twins:'twins'};
const paths: Record<IconName, React.ReactNode> = {
 budget:<><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 4 16 4 16 0V5M4 11v6c0 4 16 4 16 0v-6M9 9v10M15 9v10"/></>,
 expiry:<><path d="M6 3h12M6 21h12M7 3v4l10 10v4M17 3v4 0L7 17v4M9 17h6"/></>,
 custody:<><circle cx="8" cy="8" r="5"/><path d="m11.5 11.5 9 9m-3-3 3-3m-6 0 3-3M6 8h.01"/></>,
 core:<><circle cx="12" cy="12" r="4"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="18" cy="19" r="2"/><path d="m6.5 6.5 3 3M15 9l2.5-2M14.5 15l2 2.5M5 19l4-4"/></>,
 stocks:<><path d="M5 2v20M12 3v18M19 2v20"/><rect x="3" y="8" width="4" height="7" rx="1"/><rect x="10" y="5" width="4" height="8" rx="1"/><rect x="17" y="11" width="4" height="7" rx="1"/></>,
 smallCaps:<><path d="M12 22V12M12 15C5 15 3 11 3 6c6 0 9 3 9 9ZM12 12c0-6 4-9 9-9 0 6-3 9-9 9ZM5 22h14"/></>,
 squared:<><path d="M3 4v17h18M5 18c6 0 9-5 10-13M18 3c4-2 5 2 2 4l-2 2h4"/></>,
 factors:<><path d="M5 8h14l-2 12H7L5 8ZM9 8l3-6 3 6M3 8h18M10 11v6M14 11v6"/></>,
 tickets:<><path d="M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4V6ZM15 7v2m0 2v2m0 2v2M6 12h6"/></>,
 twins:<><path d="M8 4c-7 2-7 14 0 16M16 4c7 2 7 14 0 16M9 4v16M15 4v16M11 8h2m-2 4h2m-2 4h2"/></>,
 trade:<><path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"/></>,
 portfolio:<><path d="M3 8h18v12H3V8ZM8 8V4h8v4M3 12l9 3 9-3M10 14v3h4v-3"/></>,
 orders:<><path d="M5 3h14v18H5V3ZM9 7h7M9 12h7M9 17h7M7 7h.01M7 12h.01M7 17h.01"/></>,
 oracle:<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path d="M12 2v1M12 21v1"/></>,
 network:<><circle cx="12" cy="12" r="3"/><circle cx="5" cy="4" r="2"/><circle cx="20" cy="7" r="2"/><circle cx="18" cy="21" r="2"/><circle cx="3" cy="18" r="2"/><path d="m6 6 4 4m5 1 3-3m-5 7 3 4m-7-5-4 3"/></>,
 receipt:<><path d="M5 3h14v19l-3-2-4 2-4-2-3 2V3ZM8 7h8M8 11h5m-5 5 2 2 5-4"/></>,
 governance:<><path d="M3 8 12 2l9 6H3ZM3 21h18M5 10v8M10 10v8M14 10v8M19 10v8M4 18h16"/></>,
 waterfall:<path d="M3 3h6v6h6v6h6v6M3 7h3m3 6h3m3 6h3"/>,
 permission:<><path d="M7 10V7a5 5 0 0 1 10 0v3M4 10h16v12H4V10Z"/><circle cx="12" cy="15" r="2"/><path d="M12 17v2"/></>,
 volume:<><path d="M3 9h4l5-5v16l-5-5H3V9ZM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
 muted:<><path d="M3 9h4l5-5v16l-5-5H3V9Zm13 0 6 6m-6 0 6-6"/></>,
 compass:<><circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5 5-3ZM12 2v2M12 20v2M2 12h2M20 12h2"/></>,
 arrow:<path d="M4 12h16m-6-6 6 6-6 6"/>,
 github: <path d="M9 19c-4.3 1.3-4.3-2.1-6-2.6m12 5v-3.9a3.4 3.4 0 0 0-1-2.6c3.3-.4 6.7-1.6 6.7-7.3A5.7 5.7 0 0 0 19.1 4a5.3 5.3 0 0 0-.1-3.6s-1.3-.4-4.4 1.6a15.4 15.4 0 0 0-8 0C3.5 0 2.2.4 2.2.4A5.3 5.3 0 0 0 2.1 4 5.7 5.7 0 0 0 .5 8c0 5.7 3.4 6.9 6.7 7.3a3.4 3.4 0 0 0-1 2.6v3.5" transform="translate(1 1) scale(.9)"/>,
 telegram:<><path d="m22 3-4 18-7-6-4 3 1-6L22 3 2 10l6 2"/><path d="m8 12 10-6-7 9"/></>, x:<><path d="m4 3 13 18h3L7 3H4Z"/><path d="m20 3-6.5 7.6M4 21l6.5-7.6"/></>,
 grid:<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
 chart:<><path d="M3 3v18h18M6 15l4-5 4 3 6-8"/></>, wallet:<><path d="M20 8V5H5a2 2 0 0 1 0-4h13v4M5 5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h15V8H5"/><path d="M20 12h-6v5h6"/></>,
 bot:<><rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 7V3M9 3h6M8 12h.01M16 12h.01M8 16h8M1 11v5M23 11v5"/></>,
 shield:<><path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z"/><path d="m8 12 3 3 5-6"/></>, search:<><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></>, close:<path d="m6 6 12 12M6 18 18 6"/>, menu:<path d="M3 6h18M3 12h18M3 18h18"/>,
 star:<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4L2.9 9.7l6.3-.9L12 3Z"/>, settings:<><circle cx="12" cy="12" r="4"/><path d="m10 2-1 3-3 1-3-1-2 4 2 3-2 3 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-2-3 2-3-2-4-3 1-3-1-1-3h-4Z"/></>,
 copy:<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></>, check:<path d="m5 12 4 4L20 5"/>, plus:<path d="M12 4v16M4 12h16"/>, download:<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>, clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>, layers:<path d="m12 2 10 6-10 6L2 8l10-6Zm-10 10 10 6 10-6M2 16l10 6 10-6"/>, log:<><path d="M5 3h14v18H5V3ZM8 7h8M8 11h8M8 15h5"/></>, sun:<><circle cx="12" cy="12" r="4"/><path d="M12 1v2M12 21v2M1 12h2M21 12h2m-17-7 2 2m10 10 2 2M5 19l2-2M17 7l2-2"/></>, chevron:<path d="m9 5 7 7-7 7"/>,pause:<path d="M8 5v14M16 5v14"/>,play:<path d="m8 4 12 8-12 8V4Z"/>
};
export function Icon({name,size=20,style,botanical=false}: {name:IconName;size?:number;style?:CSSProperties;botanical?:boolean}){
 if(botanical)return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style} className="botanical-icon" data-icon={name}><path d="M16 2c3 0 4.5 2 4.5 4.6 2.7-.6 5.2.6 6.3 3.1 1 2.5.3 4.8-1.7 6.3 2 1.5 2.7 3.8 1.7 6.3-1.1 2.5-3.6 3.7-6.3 3.1C20.5 28 19 30 16 30s-4.5-2-4.5-4.6c-2.7.6-5.2-.6-6.3-3.1-1-2.5-.3-4.8 1.7-6.3-2-1.5-2.7-3.8-1.7-6.3 1.1-2.5 3.6-3.7 6.3-3.1C11.5 4 13 2 16 2Z" opacity=".55" strokeWidth=".9"/><path d="M25 26c2-1 4-1 5 1-2 1-3 1-5-1Zm-1-2 2 4" strokeWidth=".8"/><g transform="translate(7 7) scale(.75)" strokeWidth="1.8">{paths[name]}</g></svg>;
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style} data-icon={name}>{paths[name]}</svg>
}
