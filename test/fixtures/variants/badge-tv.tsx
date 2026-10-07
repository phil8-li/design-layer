// A tailwind-variants component: the same axes, one argument earlier.
import { tv } from "tailwind-variants"

export const badge = tv({
  base: "inline-flex items-center rounded-full border px-2",
  variants: {
    intent: {
      neutral: "bg-muted text-muted-foreground",
      success: "bg-emerald-100 text-emerald-900",
      danger: "bg-red-100 text-red-900",
    },
    density: {
      compact: "py-0",
      cozy: "py-1",
    },
  },
  defaultVariants: {
    intent: "neutral",
    density: "cozy",
  },
})

export function Badge({ intent, density }: { intent?: string; density?: string }) {
  return <span className={badge({ intent, density })} />
}
