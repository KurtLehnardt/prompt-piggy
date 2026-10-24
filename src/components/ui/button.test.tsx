import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Button } from './button'

afterEach(() => {
  cleanup()
})

describe('Button', () => {
  it('renders an accessible button with the default variant', () => {
    render(<Button>Smash the pig</Button>)
    const button = screen.getByRole('button', { name: 'Smash the pig' })
    expect(button.getAttribute('data-slot')).toBe('button')
    expect(button.className).toContain('bg-primary')
  })

  it('calls onClick when pressed', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Press</Button>)
    fireEvent.click(screen.getByRole('button', { name: 'Press' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does not call onClick when disabled', () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Locked
      </Button>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Locked' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('applies the variant and size classes', () => {
    render(
      <Button variant="outline" size="lg">
        Outline
      </Button>
    )
    const button = screen.getByRole('button', { name: 'Outline' })
    expect(button.className).toContain('border-border')
    expect(button.className).toContain('h-9')
  })
})
