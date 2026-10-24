import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AvatarGlow } from './avatar-glow'

afterEach(cleanup)

describe('AvatarGlow', () => {
  it('shows initials when there is no avatar', () => {
    render(<AvatarGlow name="Ada Lovelace" avatarUrl={null} auraBps={0} />)
    expect(screen.getByText('AL')).toBeTruthy()
  })
  it('falls back to initials for a non-Google host', () => {
    render(<AvatarGlow name="Bob" avatarUrl="https://evil.example/x.png" auraBps={0} />)
    expect(screen.queryByRole('img', { name: 'Bob' })?.tagName).not.toBe('IMG')
    expect(screen.getByText('B')).toBeTruthy()
  })
  it('renders an image for a Google avatar', () => {
    render(<AvatarGlow name="Cy" avatarUrl="https://lh3.googleusercontent.com/a/x" auraBps={0} />)
    expect(document.querySelector('img')).toBeTruthy()
  })
  it('has no shadow at 0, a bounded shadow at max', () => {
    const { rerender } = render(<AvatarGlow name="D" avatarUrl={null} auraBps={0} />)
    const disc = () => screen.getByTestId('avatar-glow').firstElementChild as HTMLElement
    expect(disc().style.boxShadow).toMatch(/^(none)?$/)
    rerender(<AvatarGlow name="D" avatarUrl={null} auraBps={10000} />)
    expect(disc().style.boxShadow).toContain('4px')
    expect(disc().style.boxShadow).toContain('6px')
  })
  it('pulses only at 0.5 and above', () => {
    const { rerender } = render(<AvatarGlow name="E" avatarUrl={null} auraBps={4999} />)
    const disc = () => screen.getByTestId('avatar-glow').firstElementChild as HTMLElement
    expect(disc().dataset.pulse).toBe('false')
    rerender(<AvatarGlow name="E" avatarUrl={null} auraBps={5000} />)
    expect(disc().dataset.pulse).toBe('true')
  })
  it('css disables the pulse under reduced motion', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/player/avatar-glow.module.css'), 'utf8')
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none/)
  })
})
