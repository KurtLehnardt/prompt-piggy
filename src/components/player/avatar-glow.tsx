import Image from 'next/image'
import { glowFor, shouldPulse } from '@/lib/aura/glow'
import styles from './avatar-glow.module.css'

export type AvatarGlowProps = {
  name: string
  avatarUrl: string | null
  /** Server-computed aura, 0..10000. */
  auraBps: number
  sizePx?: number
}

const COLORS = ['#e11d48', '#7c3aed', '#2563eb', '#0d9488', '#d97706', '#4f46e5']

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.slice(0, 2).map((p) => Array.from(p)[0] ?? '')
  return letters.join('').toUpperCase() || '?'
}

function colorOf(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return COLORS[h % COLORS.length]
}

function isGoogleAvatar(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === 'lh3.googleusercontent.com'
  } catch {
    return false
  }
}

export function AvatarGlow({ name, avatarUrl, auraBps, sizePx = 40 }: AvatarGlowProps) {
  const g = glowFor(auraBps)
  const pulse = shouldPulse(auraBps)
  const shadow =
    g.opacity > 0 ? `0 0 ${g.blurPx}px ${g.spreadPx}px rgba(250, 204, 21, ${g.opacity})` : 'none'
  const useImage = avatarUrl !== null && isGoogleAvatar(avatarUrl)
  return (
    <span className={styles.wrap} data-testid="avatar-glow">
      <span
        className={`${styles.disc} ${pulse ? styles.pulse : ''}`}
        data-pulse={pulse ? 'true' : 'false'}
        style={{
          width: sizePx,
          height: sizePx,
          boxShadow: shadow,
          background: useImage ? undefined : colorOf(name),
          fontSize: Math.round(sizePx * 0.4),
        }}
      >
        {useImage ? (
          <Image src={avatarUrl} alt={name} width={sizePx} height={sizePx} />
        ) : (
          <span aria-label={name} role="img">
            {initialsOf(name)}
          </span>
        )}
      </span>
    </span>
  )
}
