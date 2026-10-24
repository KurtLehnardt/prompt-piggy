import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Joins class names and resolves conflicting Tailwind utilities so that the
 * last one wins. Every shadcn/ui primitive uses this helper.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
