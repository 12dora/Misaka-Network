import { useId } from 'react'

// A11Y-003 — the settings toggles were bare `<button>`s with no text
// content, no `role`, no `aria-checked` and no label association. A screen
// reader announced "button", full stop: no name, no state, no way to tell
// TURN from force-relay from sound. Voice control had nothing to say.
//
// This wraps the same visual switch in real switch semantics and pairs it
// with a clickable label, so the whole row is also a 44 px-tall hit target.

interface Props {
  checked: boolean
  onChange: (next: boolean) => void
  /** Visible label text. */
  label: string
  /** Optional supporting text, associated via aria-describedby. */
  description?: string
  disabled?: boolean
  /** Tailwind classes for the label text (each row styles its own scale). */
  labelClassName?: string
  /** Colour of the track when on. Defaults to the success token. */
  onColor?: string
}

export default function MisakaSwitch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  labelClassName = 'font-kanji text-sm text-[var(--text-on-white)]',
  onColor = 'var(--state-success)',
}: Props) {
  const id = useId()
  const labelId = `switch-label-${id}`
  const descId = `switch-desc-${id}`

  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={`switch-${id}`} className={`${labelClassName} cursor-pointer min-w-0`}>
        <span id={labelId}>{label}</span>
        {description && (
          <span
            id={descId}
            className="block font-kanji text-[11px] text-[var(--text-muted-on-light)] leading-snug mt-0.5"
          >
            {description}
          </span>
        )}
      </label>
      <button
        id={`switch-${id}`}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descId : undefined}
        disabled={disabled}
        onClick={() => { if (!disabled) onChange(!checked) }}
        className="tap-target w-10 h-6 rounded-full transition-colors relative shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          border: 'none',
          background: checked ? onColor : 'var(--text-muted)',
        }}
      >
        <span
          className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform"
          style={{ left: checked ? 'calc(100% - 22px)' : '2px' }}
        />
      </button>
    </div>
  )
}
