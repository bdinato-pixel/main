import { useEffect, useRef, useState } from 'react';

interface Props {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  /** Minimum allowed value (default 0 — negatives are always rejected). */
  min?: number;
  max?: number;
  /** Restrict to whole numbers. */
  integer?: boolean;
  /** Empty field yields `undefined` instead of 0, and 0 shows as blank. */
  allowEmpty?: boolean;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}

function display(value: number | undefined, allowEmpty: boolean): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '';
  if (allowEmpty && value === 0) return '';
  return String(value);
}

/**
 * Numeric input that lets you type freely — including sub-1 decimals like
 * 0.0027 — by keeping the raw text as the source of truth while focused
 * (a number-typed controlled input coerces "0." back to 0 and wipes the
 * decimal). Rejects negatives and the exponent key.
 */
export function NumberInput({
  value,
  onChange,
  min = 0,
  max,
  integer = false,
  allowEmpty = false,
  placeholder,
  disabled,
  title,
  className,
  style,
}: Props) {
  const [text, setText] = useState(() => display(value, allowEmpty));
  const editing = useRef(false);

  // Re-sync from the prop when the value changes externally (never mid-edit,
  // which would fight the user's keystrokes).
  useEffect(() => {
    if (!editing.current) setText(display(value, allowEmpty));
  }, [value, allowEmpty]);

  return (
    <input
      type="number"
      inputMode="decimal"
      step={integer ? 1 : 'any'}
      min={min}
      max={max}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      title={title}
      className={className}
      style={style}
      onFocus={() => {
        editing.current = true;
      }}
      onBlur={() => {
        editing.current = false;
        setText(display(value, allowEmpty));
      }}
      onKeyDown={(e) => {
        // No negative or exponent notation for prices/amounts.
        if (e.key === '-' || e.key === 'e' || e.key === 'E' || e.key === '+') e.preventDefault();
      }}
      onChange={(e) => {
        let t = e.target.value.replace(/-/g, '');
        if (integer) t = t.replace(/[.,].*/, '');
        setText(t);
        if (t === '' || t === '.') {
          onChange(allowEmpty ? undefined : 0);
          return;
        }
        const n = Number(t);
        if (Number.isFinite(n)) onChange(n < min ? min : max !== undefined && n > max ? max : n);
      }}
    />
  );
}
