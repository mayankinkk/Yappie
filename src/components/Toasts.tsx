import { useRoom } from "../stores/room";

export default function Toasts() {
  const toasts = useRoom((s) => s.toasts);
  const dismiss = useRoom((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          className={`toast ${t.kind === "error" ? "toast-error" : ""}`}
          onClick={() => dismiss(t.id)}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}
