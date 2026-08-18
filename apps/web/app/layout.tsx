import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { RevealBanner } from '../components/RevealBanner';
import { RiskGate } from '../components/RiskGate';
import { Web3Provider } from '../components/Web3Provider';
import './globals.css';

const TITLE = 'Bithook — block-mined token on Uniswap v4';
const DESCRIPTION =
  'Experimental, unaudited, written entirely by AI. 21M cap, mined in ten-minute blocks by predicting the pool\u2019s own price, all fees burned. High risk of total loss.';

export const metadata: Metadata = {
  // Required for the OG/Twitter image to resolve to an absolute URL — social
  // scrapers reject relative paths and would silently show no image.
  metadataBase: new URL('https://bithook.tools'),
  title: TITLE,
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    url: 'https://bithook.tools',
    siteName: 'Bithook',
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Bithook' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Ambient colour field the glass surfaces refract. Pure CSS — no images,
            no external requests, nothing for the CSP to allow. */}
        <div className="orbs" aria-hidden="true">
          <div className="orb o1" />
          <div className="orb o2" />
          <div className="orb o3" />
          <div className="orb o4" />
          <div className="orb o5" />
          <div className="orb o6" />
          <div className="orb o7" />
          <div className="orb o8" />
          <div className="orb o9" />
        </div>
        {/* Not dismissible, on every route, by design. */}
        <div className="riskstrip" role="alert">
          <b>Written entirely by AI. No human has reviewed this code.</b>{' '}
          Experimental and unaudited — assume it can be hacked and that you will
          lose everything you put in.
        </div>
        <RiskGate />
        <Web3Provider>
          <RevealBanner />
          {children}
        </Web3Provider>
      </body>
    </html>
  );
}
