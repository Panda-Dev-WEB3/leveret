import type { Metadata } from 'next';
import './globals.css';
import './website-v2.css';
import './dashboard-v2.css';
import './website-v3.css';
import './website-v4.css';
import './website-v5.css';
import './website-v7.css';
import './website-v9.css';
import {ButtonFeedback} from '@/components/button-feedback';
import {BloomNavigation} from '@/components/bloom-navigation';
export const metadata: Metadata = { title: { default: 'Leveret — Every price. One account.', template: '%s · Leveret' }, description: 'Seven ways to trade from one USDC balance. A shared Solana margin account for people and agents.', icons: { icon: '/brand/logo.webp' } };
export default function RootLayout({children}: {children: React.ReactNode}) { return <html lang="en"><body><BloomNavigation>{children}<ButtonFeedback/></BloomNavigation></body></html>; }
