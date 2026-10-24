'use client'

import { LogOut } from 'lucide-react'
import { useRef } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/components/providers/auth-provider'

/** Up to two initials from the display name, for the avatar fallback. */
export function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? '')
    .join('')
  return letters || '?'
}

/**
 * The signed-in player's avatar and name, with a menu that signs out.
 *
 * Sign-out is a real form POST to /auth/signout, which checks the Origin and
 * answers with a redirect to /. The form sits outside the menu's portal, and
 * the menu item submits it, so it also works if the menu closes first.
 */
export function UserMenu() {
  const { displayName, avatarUrl } = useAuth()
  const signOutForm = useRef<HTMLFormElement>(null)

  return (
    <>
      <form ref={signOutForm} action="/auth/signout" method="post" hidden aria-hidden />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-2 rounded-full p-1 pr-3 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label={`Account menu for ${displayName}`}
          data-testid="user-menu-trigger"
        >
          <Avatar size="sm">
            {avatarUrl ? <AvatarImage src={avatarUrl} alt="" referrerPolicy="no-referrer" /> : null}
            <AvatarFallback>{initialsOf(displayName)}</AvatarFallback>
          </Avatar>
          <span className="max-w-40 truncate font-medium" data-testid="user-menu-name">
            {displayName}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="truncate">{displayName}</DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => signOutForm.current?.requestSubmit()} data-testid="user-menu-sign-out">
            <LogOut aria-hidden />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
