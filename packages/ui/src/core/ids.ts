import { useRef } from 'preact/hooks'

let counter = 0

/**
 * An id prefix that is unique to one mounted component. Every open tab keeps its panel mounted, so two script
 * pages are in the document at once: a fixed id (`run-form`, `f_name`) would collide, and `<label for>` /
 * `<button form>` would silently point at the first page's element.
 */
export function useUid(prefix = 'u'): string {
  const ref = useRef<string | undefined>(undefined)
  if (!ref.current) ref.current = `${prefix}${++counter}`
  return ref.current
}
