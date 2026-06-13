type SwitchProps = {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  size?: 'default' | 'sm';
};

/** Binary toggle. Mirrors the shipped `.settings-switch` (blue = enabled). */
export function Switch({ checked, onChange, disabled, ariaLabel, size = 'default' }: SwitchProps) {
  return (
    <label className={size === 'sm' ? 'settings-switch settings-switch-sm' : 'settings-switch'}>
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
