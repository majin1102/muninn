type SwitchProps = {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
};

/** Binary toggle. Mirrors the shipped `.settings-switch` (blue = enabled). */
export function Switch({ checked, onChange, disabled, ariaLabel }: SwitchProps) {
  return (
    <label className="settings-switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange?.(event.target.checked)}
      />
      <span />
    </label>
  );
}
