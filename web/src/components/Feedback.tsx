import { AlertTriangle, CheckCircle2, Info, Trash2, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/* ================================================================ toasts */

type ToastKind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

/* =============================================================== confirm */

export interface ConfirmOption {
  key: string;
  label: string;
  defaultValue?: boolean;
}

export interface ConfirmRequest {
  title: string;
  message?: ReactNode;
  items?: string[];
  confirmText?: string;
  danger?: boolean;
  options?: ConfirmOption[];
}

type ConfirmResult = false | Record<string, boolean>;

interface FeedbackApi {
  toast: (kind: ToastKind, title: string, message?: string) => void;
  confirm: (req: ConfirmRequest) => Promise<ConfirmResult>;
}

const FeedbackCtx = createContext<FeedbackApi | null>(null);

export function useFeedback() {
  const ctx = useContext(FeedbackCtx);
  if (!ctx) throw new Error('FeedbackProvider missing');
  return ctx;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<(ConfirmRequest & { resolve: (r: ConfirmResult) => void }) | null>(null);
  const seq = useRef(0);

  const toast = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-4), { id, kind, title, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3200);
  }, []);

  const confirm = useCallback(
    (req: ConfirmRequest) => new Promise<ConfirmResult>((resolve) => setPending({ ...req, resolve })),
    [],
  );

  return (
    <FeedbackCtx.Provider value={{ toast, confirm }}>
      {children}
      {createPortal(
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.kind === 'success' ? <CheckCircle2 size={18} /> : t.kind === 'error' ? <XCircle size={18} /> : <Info size={18} />}
              <div className="grow">
                <div className="t">{t.title}</div>
                {t.message && <div className="m">{t.message}</div>}
              </div>
            </div>
          ))}
        </div>,
        document.body,
      )}
      {pending && (
        <ConfirmDialog
          req={pending}
          onClose={(r) => {
            pending.resolve(r);
            setPending(null);
          }}
        />
      )}
    </FeedbackCtx.Provider>
  );
}

function ConfirmDialog({ req, onClose }: { req: ConfirmRequest; onClose: (r: ConfirmResult) => void }) {
  const [values, setValues] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((req.options || []).map((o) => [o.key, !!o.defaultValue])),
  );
  const confirmBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-body">
          <div className={`ico ${req.danger ? 'tone-red' : 'tone-yellow'}`}>
            {req.danger ? <Trash2 size={19} /> : <AlertTriangle size={19} />}
          </div>
          <div className="grow">
            <h3>{req.title}</h3>
            {req.message && <div className="msg">{req.message}</div>}
            {req.items && req.items.length > 0 && (
              <ul className="modal-list">
                {req.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            )}
            {req.options && req.options.length > 0 && (
              <div className="modal-options">
                {req.options.map((o) => (
                  <label className="check" key={o.key}>
                    <input
                      type="checkbox"
                      checked={values[o.key]}
                      onChange={(e) => setValues((v) => ({ ...v, [o.key]: e.target.checked }))}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => onClose(false)}>
            取消
          </button>
          <button ref={confirmBtn} className={`btn ${req.danger ? 'danger' : 'primary'}`} onClick={() => onClose(values)}>
            {req.confirmText || '确认'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
