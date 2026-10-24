import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PresenceStrip } from './presence-strip'
import { PresenceWall, wallLayout } from './presence-wall'
import type { LivePlayerDTO } from '@/types/api'

/** The presence strip and wall (ARCHITECTURE sections 9.7 and 12.2; CH-2, CH-3, CH-6). */

function player(index: number, auraBps = 0, extra: Partial<LivePlayerDTO> = {}): LivePlayerDTO {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `Player ${index}`,
    avatarUrl: null,
    auraBps,
    lastSeenBucket: 0,
    ...extra,
  }
}

afterEach(() => {
  cleanup()
})

describe('PresenceWall', () => {
  it('renders an avatar glow for each player with the server aura', () => {
    render(<PresenceWall players={[player(1, 10_000), player(2, 0)]} />)
    const wall = screen.getByTestId('presence-wall')
    const glows = within(wall).getAllByTestId('avatar-glow')
    expect(glows).toHaveLength(2)
    const discs = glows.map((glow) => glow.firstElementChild as HTMLElement)
    expect(discs[0].style.boxShadow).toContain('rgba(250, 204, 21, 1)')
    expect(discs[0].dataset.pulse).toBe('true')
    expect(discs[1].style.boxShadow === '' || discs[1].style.boxShadow === 'none').toBe(true)
    expect(within(wall).getByText('2 players online')).toBeTruthy()
  })

  it('renders names as text, never as markup', () => {
    const name = '<img src=x onerror=alert(1)>'
    const { container } = render(<PresenceWall players={[player(1, 0, { name })]} />)
    expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    expect(container.querySelector('img[src="x"]')).toBeNull()
  })

  it('is sized for a 1920x1080 projector: smaller avatars without names as the room fills', () => {
    expect(wallLayout(10)).toEqual({ sizePx: 112, showNames: true })
    expect(wallLayout(30)).toEqual({ sizePx: 88, showNames: true })
    expect(wallLayout(60)).toEqual({ sizePx: 72, showNames: false })
    expect(wallLayout(150)).toEqual({ sizePx: 56, showNames: false })

    render(<PresenceWall players={Array.from({ length: 100 }, (_, index) => player(index + 1))} />)
    expect(screen.getAllByTestId('avatar-glow')).toHaveLength(100)
    expect(screen.queryByText('Player 1')).toBeNull()
    expect(screen.getAllByLabelText('Player 1').length).toBeGreaterThan(0)
  })

  it('shows everyone on /live: no cap', () => {
    render(<PresenceWall players={Array.from({ length: 150 }, (_, index) => player(index + 1))} />)
    expect(screen.getAllByTestId('avatar-glow')).toHaveLength(150)
  })
})

describe('PresenceStrip', () => {
  it('renders an avatar glow per player and caps the strip at 30 (R3-02)', () => {
    render(<PresenceStrip players={Array.from({ length: 45 }, (_, index) => player(index + 1, 5_000))} />)
    const glows = screen.getAllByTestId('avatar-glow')
    expect(glows).toHaveLength(30)
    expect((glows[0].firstElementChild as HTMLElement).style.boxShadow).toContain('rgba(250, 204, 21')
  })

  it('says when it is loading or empty', () => {
    const { rerender } = render(<PresenceStrip players={null} />)
    expect(screen.getByText('Loading players...')).toBeTruthy()
    rerender(<PresenceStrip players={[]} />)
    expect(screen.getByText('Just you so far')).toBeTruthy()
  })
})

describe('source rules (CH-6)', () => {
  const ROOT = join(process.cwd(), 'src')
  const DIRS = ['components/live', 'components/presence', 'app/live', 'components/treasury']

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry)
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : []
    })
  }

  const sources = DIRS.flatMap((dir) => files(join(ROOT, dir))).map((path) => ({ path, text: readFileSync(path, 'utf8') }))

  it('scans the /live, presence, and treasury sources', () => {
    expect(sources.length).toBeGreaterThanOrEqual(10)
  })

  it('has no dangerouslySetInnerHTML under src/components/live, src/components/presence, or src/app/live', () => {
    for (const { path, text } of sources) expect(text.includes('dangerouslySetInnerHTML'), path).toBe(false)
  })

  it('declares no prompt, reply, excerpt, or email field in any prop type', () => {
    const field = /^\s*(?:readonly\s+)?(?:prompt|reply|excerpt|email)\w*\??\s*:/im
    for (const { path, text } of sources) expect(field.test(text), path).toBe(false)
  })
})
