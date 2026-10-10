import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// Register the custom shadow tokens from globals.css (@theme) so overrides such as
// `shadow-none` replace `shadow-raised` instead of both classes surviving the merge.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ["raised", "lifted", "glow", "float"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  const normalized = Number.isFinite(index) ? Math.trunc(index) : 0;
  return Math.min(Math.max(normalized, 0), length - 1);
}
