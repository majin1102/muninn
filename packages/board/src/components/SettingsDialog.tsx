import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BoardClient } from '../lib/api.js';
import { asErrorMessage } from '../lib/utils.js';
import { validateSettingsJson } from '../server/settings.js';
import { Button } from './ui/button.js';

type SettingsDialogProps = {
  client: BoardClient;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SettingsDialog({ client, open, onOpenChange }: SettingsDialogProps) {
  const [pathLabel, setPathLabel] = useState('muninn.json');
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || content || loading) {
      return;
    }

    setLoading(true);
    setError(null);
    client.getSettingsConfig()
      .then((response) => {
        validateSettingsJson(response.content);
        setPathLabel(response.pathLabel);
        setContent(response.content);
        setDraft(response.content);
      })
      .catch((loadError: unknown) => setError(asErrorMessage(loadError)))
      .finally(() => setLoading(false));
  }, [client, content, loading, open]);

  if (!open) {
    return null;
  }

  async function save() {
    try {
      validateSettingsJson(draft);
      setSaving(true);
      setError(null);
      const response = await client.saveSettingsConfig(draft);
      setPathLabel(response.pathLabel);
      setContent(response.content);
      setDraft(response.content);
      setEditing(false);
    } catch (saveError) {
      setError(asErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={() => onOpenChange(false)}>
      <section className="settings-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="settings-dialog-header">
          <div>
            <h2>Settings</h2>
            <p>{pathLabel}</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close settings" onClick={() => onOpenChange(false)}>
            <X />
          </Button>
        </header>
        <div className="settings-dialog-body">
          {loading ? <div className="empty-state">Loading muninn.json...</div> : null}
          {error ? <div className="error-state">{error}</div> : null}
          <textarea
            className="settings-editor"
            readOnly={!editing}
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <footer className="settings-dialog-footer">
          <span>{editing ? 'Validate and save the setting file.' : 'Open editing to update the setting file.'}</span>
          <Button onClick={() => (editing ? void save() : setEditing(true))} disabled={saving}>
            {saving ? 'Saving...' : editing ? 'Save' : 'Edit'}
          </Button>
        </footer>
      </section>
    </div>
  );
}
