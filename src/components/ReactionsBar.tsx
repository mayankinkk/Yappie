import { useRef } from "react";
import { useRoom } from "../stores/room";

const EMOJIS = ["🔥", "😂", "❤️", "👏", "😮", "🎉", "😭"];

interface Props {
  disabled?: boolean;
}

export default function ReactionsBar({ disabled }: Props) {
  const react = useRoom((s) => s.react);
  const lastRef = useRef(0);

  function fire(emoji: string) {
    const now = Date.now();
    if (now - lastRef.current < 400) return;
    lastRef.current = now;
    react(emoji);
  }

  return (
    <div className="reactions-bar" role="toolbar" aria-label="Reactions">
      {EMOJIS.map((e) => (
        <button
          key={e}
          className="reaction-btn"
          disabled={disabled}
          onClick={() => fire(e)}
          title={`React ${e}`}
        >
          {e}
        </button>
      ))}
    </div>
  );
}
