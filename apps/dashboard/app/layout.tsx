import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Shell } from '@/components/Shell';
import { SessionProvider } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = { title: 'SOL·TERM', description: 'Private Solana trading terminal', robots: { index: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body data-mode="READ_ONLY">
        <SessionProvider>
          <Shell>{children}</Shell>
        </SessionProvider>
      </body>
    </html>
  );
}
