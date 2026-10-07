// A host with no variant system at all: the degrade-to-nothing case.
import { clsx } from "clsx"

const styles = clsx("rounded-md", "border")

export function Plain({ label }: { label: string }) {
  return <div className={styles}>{label}</div>
}
