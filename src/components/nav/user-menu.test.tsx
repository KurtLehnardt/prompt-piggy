import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AuthProvider } from '@/components/providers/auth-provider'
import { initialsOf, UserMenu } from './user-menu'

afterEach(() => {
  cleanup()
})

describe('initialsOf', () => {
  it.each([
    ['Pat Player', 'PP'],
    ['pat', 'P'],
    ['  Ada   Lovelace  King ', 'AL'],
    ['Player 0042', 'P0'],
    ['Émile Zola', 'ÉZ'],
    ['', '?'],
    ['   ', '?'],
  ])('%j -> %j', (name, expected) => {
    expect(initialsOf(name)).toBe(expected)
  })
})

describe('UserMenu', () => {
  it("shows the player's name and posts sign-out to /auth/signout", () => {
    render(
      <AuthProvider user={{ userId: 'u1', displayName: 'Pat Player', avatarUrl: null }}>
        <UserMenu />
      </AuthProvider>
    )
    expect(screen.getByTestId('user-menu-name').textContent).toBe('Pat Player')
    const form = document.querySelector('form')
    expect(form?.getAttribute('action')).toBe('/auth/signout')
    expect(form?.getAttribute('method')).toBe('post')
  })
})
