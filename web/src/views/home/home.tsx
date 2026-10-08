import Link from 'next/link';
import {Header} from '@/components/shell';
import {ExploreLink} from '@/components/explore-link';
import {HeroScene} from '@/components/hero-scene';
import {ScrollLayout} from '@/layouts/scroll-layout';
import {destinationsContent,philosophyContent,travelContent,planContent} from '@/data/mocks/home';
import {Destinations} from './destinations';
import {Philosophy} from './philosophy';
import {Travel} from './travel';
import {Plan} from './plan';
export function HomeView(){return <ScrollLayout><main className="template-home"><section className="hero"><HeroScene/><div className="hero-shade"/><Header light/><div className="hero-copy"><div className="eyebrow">ONE USDC BALANCE / ON SOLANA</div><h1>Every price.<br/><em>One account.</em></h1><p>For the conviction that takes you somewhere new.<br/>Seven product families, rooted in one balance.</p><div className="hero-actions"><Link className="btn" href="/dashboard/">Enter Leveret</Link><ExploreLink/></div></div><div className="hero-bottom"><span>FOR PEOPLE AND AGENTS</span><span>A WIDER FIELD OF POSSIBILITY</span><span>SCROLL TO EXPLORE</span></div></section><div id="possibilities"><Destinations content={destinationsContent}/></div><Philosophy content={philosophyContent}/><Travel content={travelContent}/><Plan content={planContent}/></main></ScrollLayout>}
