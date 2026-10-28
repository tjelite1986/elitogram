import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post } from '../api';
import { Icon } from '../icons';
import { Modal, errorText, useSession, useToast } from '../ui';

export function PinPrompt({ onClose }: { onClose: () => void }) {
  const { me, refresh } = useSession();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const nav = useNavigate();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/api/adult/unlock', { pin });
      await refresh();
      onClose();
      window.dispatchEvent(new Event('eg-adult'));
    } catch (err) {
      setError(errorText(err));
      setPin('');
    }
  };
  return (
    <Modal title="Show 18+ content" onClose={onClose}>
      {!me?.has_pin ? (
        <>
          <p className="muted">You have not set a PIN yet.</p>
          <div className="modal-actions">
            <button className="btn secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn"
              onClick={() => {
                onClose();
                nav('/settings/adult');
              }}
            >
              Set a PIN
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            placeholder="PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            aria-label="PIN"
          />
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" disabled={pin.length < 4}>
              Unlock
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Lock icon in the navigation: shows the gate's state and toggles it. */
export function AdultToggle({ rail }: { rail?: boolean }) {
  const { adultUntil, refresh } = useSession();
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const unlocked = !!adultUntil && adultUntil > Date.now();
  const click = async () => {
    if (!unlocked) return setOpen(true);
    try {
      await post('/api/adult/lock');
      await refresh();
      window.dispatchEvent(new Event('eg-adult'));
      toast({ text: '18+ content hidden' });
    } catch (err) {
      toast({ text: errorText(err), error: true });
    }
  };
  return (
    <>
      <button className={rail ? 'rail-item' : 'icon-btn'} onClick={click} title={unlocked ? 'Hide 18+ content' : 'Show 18+ content'} aria-label={unlocked ? 'Hide 18+ content' : 'Show 18+ content'}>
        <Icon name={unlocked ? 'unlock' : 'lock'} style={unlocked ? { color: '#ef4444' } : undefined} />
        {rail && <span className="rail-label">{unlocked ? '18+ shown' : '18+ hidden'}</span>}
      </button>
      {open && <PinPrompt onClose={() => setOpen(false)} />}
    </>
  );
}
