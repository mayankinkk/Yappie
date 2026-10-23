import { useRoom } from "../stores/room";

export default function Toasts() {
  const toasts = useRoom((s) => s.toasts);
  const dismiss = useRoom((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) =>
        t.actions?.length ? (
          <div key={t.id} className={`toast toast-actions${t.kind === "error" ? " toast-error" : ""}`}>
            <span className="toast-text">{t.text}</span>
            <span className="toast-btns">
              {t.actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className="btn small"
                  onClick={() => {
                    dismiss(t.id);
                    a.onClick();
                  }}
                >
                  {a.label}
                </button>
              ))}
            </span>
          </div>
        ) : (
          <button
            key={t.id}
            className={`toast ${t.kind === "error" ? "toast-error" : ""}`}
            onClick={() => dismiss(t.id)}
          >
            {t.text}
          </button>
        ),
      )}
    </div>
  );
}
