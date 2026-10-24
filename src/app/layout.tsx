import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'

/**
 * Root layout (docs/ARCHITECTURE.md section 1.2 rows 15 and 18). It copies
 * skylite's pattern: next/font exposes each font as a CSS variable on <body>,
 * globals.css maps those variables to Tailwind's font tokens, and the sonner
 * Toaster is mounted once at the top center. Auth lives in the (game) layout,
 * so public pages such as /login, /live, and /health render without it.
 */
const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'Prompt Piggy',
  description: 'A self-hardening prompt-security game. Talk the vault pig into paying out. All money is mocked.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
        <Toaster position="top-center" />
      </body>
    </html>
  )
}
