'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { UserMenu } from '@/components/nav/user-menu'
import { cn } from '@/lib/utils'

/** The signed-in pages of the game shell. /live is not here: it needs the projector link. */
export const NAV_LINKS = [
  { href: '/play', label: 'Play' },
  { href: '/me', label: 'Me' },
] as const

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

/** The game shell's top bar: brand, page links, and the account menu. */
export function TopBar() {
  const pathname = usePathname() ?? ''

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <nav aria-label="Main" className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
        <Link href="/play" className="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden>🐷</span>
          Prompt Piggy
        </Link>
        <ul className="flex items-center gap-1 text-sm">
          {NAV_LINKS.map((link) => {
            const active = isActive(pathname, link.href)
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                    active && 'bg-muted text-foreground'
                  )}
                >
                  {link.label}
                </Link>
              </li>
            )
          })}
        </ul>
        <div className="ml-auto">
          <UserMenu />
        </div>
      </nav>
    </header>
  )
}
