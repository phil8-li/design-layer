// A class-variance-authority component, in the shape a shadcn/ui host ships.
import { cva, type VariantProps } from "class-variance-authority"

const RUNTIME_TONE = resolveTone()

export const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        // Statically readable through a template literal with no holes.
        outline: `border border-input bg-background`,
        // Statically readable as an array, which cva accepts.
        destructive: ["bg-destructive", "text-destructive-foreground"],
        // NOT statically readable: named, offered, never applied.
        tone: RUNTIME_TONE,
      },
      size: {
        sm: "h-8 px-3 text-xs",
        default: "h-9 px-4 py-2",
        lg: "h-10 px-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export type ButtonProps = VariantProps<typeof buttonVariants>

export function Button({ variant, size, className }: ButtonProps & { className?: string }) {
  return <button className={buttonVariants({ variant, size, className })} />
}
