import type {Family} from '../data/leveret';
export interface OrderInput {family:Family;side:'Long'|'Short';margin:number;leverage:number;price:number;maxLeverage:number;barrier?:number}
export function estimateOrder(input:OrderInput){
 const {family,side,margin,price,maxLeverage}=input;
 if(!Number.isFinite(margin)||margin<=0||margin>50000||!Number.isFinite(price)||price<=0)throw new Error('Invalid margin or price');
 let leverage=family==='Twins'?1:Math.max(1,Math.min(input.leverage,maxLeverage));
 if(family==='Tickets'){
  const barrier=input.barrier??0;
  if(!Number.isFinite(barrier)||barrier<=0||(side==='Long'?barrier>price*.97:barrier<price*1.03))throw new Error('Invalid knock-out level');
  leverage=price/Math.abs(price-barrier);
 }
 const notional=margin*leverage;
 const feeRate=family==='Tickets'?.003:['Twins','Squared','Factors'].includes(family)?.001:.0006;
 const fee=notional*feeRate;
 const units=notional/price;
 const maintenance=family==='Core'?.01:.025;
 // Single-position estimate; cross-account P&L, funding, slippage and closing fees are not included.
 const liquidation=family==='Twins'||family==='Tickets'||leverage===1?null:side==='Long'?(notional+fee-margin)/(units*(1-maintenance)):(margin+notional-fee)/(units*(1+maintenance));
 return {leverage,notional,fee,units,liquidation,maximumLoss:family==='Tickets'?margin+fee:null};
}
