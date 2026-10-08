import {ProductDetail} from '@/views/marketing';
import {families} from '@/data/leveret';
export function generateStaticParams(){return families.map(f=>({slug:f.slug}))}
export async function generateMetadata({params}: {params:Promise<{slug:string}>}){const {slug}=await params;return {title:families.find(f=>f.slug===slug)?.name}}
export default async function Page({params}: {params:Promise<{slug:string}>}){const {slug}=await params;return <ProductDetail slug={slug}/>}
