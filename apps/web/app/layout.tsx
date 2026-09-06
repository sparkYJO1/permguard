import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'permguard',
  description: 'How long after a revoke does every node actually deny?',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
