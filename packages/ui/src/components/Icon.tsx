import { ICON_SPRITE } from './iconSprite'

/** The SVG symbol sprite, rendered once (hidden) so every <Icon/> can reference it. */
export function IconSprite() {
  return <svg width="0" height="0" style="position:absolute" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICON_SPRITE }} />
}

export function Icon({ name, class: cls = '', small = false, title }: { name: string; class?: string; small?: boolean; title?: string }) {
  return (
    <svg class={`i ${small ? 'i-sm' : ''} ${cls}`.trim()} aria-hidden={title ? undefined : 'true'} aria-label={title}>
      <use href={`#i-${name}`} />
    </svg>
  )
}

/** The little language badge (py, sh, bat …) of the old explorer. */
export function Lang({ ext }: { ext: string }) {
  return <span class={`lang lang-${ext}`}>{ext}</span>
}
