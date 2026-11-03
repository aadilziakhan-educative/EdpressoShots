import './globals.css';
import type { Metadata } from 'next';
import { AppShell } from './_components/AppShell';

export const metadata: Metadata = {
  title: 'Educative — Edpresso Shots',
  description: 'Generate search-first Edpresso Shots (Educative Answers) with a multi-stage AI pipeline.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
