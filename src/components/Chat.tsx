import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRoom } from "../stores/room";
import { useSession } from "../stores/session";
import { initials, nameHue } from "../lib/ids";
import { formatClock } from "../lib/time";

const EMOJIS = [
  "😀", "😂", "🥹", "😍", "😎", "🤔", "😴", "😭",
  "🥳", "😱", "😅", "🤦", "🔥", "✨", "❤️", "👍",
  "👎", "👏", "🙌", "🤝", "💯", "🎉", "⭐", "🌙",
  "🎬", "🍿", "🎧", "🎸", "🐶", "🐱", "🌍", "🚀",
];

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥"];

export default function Chat() {
  const messages = useRoom((s) => s.messages);
  const unread = useRoom((s) => s.unread);
  const sendChat = useRoom((s) => s.sendChat);
  const deleteChatMessage = useRoom((s) => s.deleteChatMessage);
  const reactToMessage = useRoom((s) => s.reactToMessage);
  const hostId = useRoom((s) => s.hostId);
  const setTyping = useRoom((s) => s.setTyping);
  const typing = useRoom((s) => s.typing);
  const markChatRead = useRoom((s) => s.markChatRead);
  const myId = useSession((s) => s.profile?.id);
  const isHost = !!myId && myId === hostId;
  const [text, setText] = useState("");
  const [tick, setTick] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setPickerOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [pickerOpen]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Local ticker so peers' typing indicators expire without a presence event.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    sendChat(text);
    setText("");
    setTyping(false);
    const el = listRef.current;
    if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  }

  void tick;
  function insertEmoji(e: string) {
    const next = (text + e).slice(0, 500);
    setText(next);
    if (next.trim()) setTyping(true);
    inputRef.current?.focus();
  }

  const typers = Object.values(typing).filter((t) => Date.now() - t.at < 4_000);
  const typingLabel =
    typers.length === 1
      ? `${typers[0].name} is typing…`
      : typers.length === 2
        ? `${typers[0].name} and ${typers[1].name} are typing…`
        : typers.length > 2
          ? `${typers.length} people are typing…`
          : "";

  return (
    <div className="card chat-card">
      <div className="card-head">
        <span>Chat</span>
        {unread > 0 && <span className="unread-pill">{unread}</span>}
      </div>
      <div
        className="messages"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) markChatRead();
        }}
      >
        {messages.length === 0 && <div className="chat-empty">Say hi 👋</div>}
        {messages.map((m) => {
          const hue = m.color ?? nameHue(m.name);
          const mine = m.senderId === myId;
          return (
            <div key={m.id} className={`msg ${mine ? "mine" : ""}`}>
              <span className="avatar" style={{ ["--h" as string]: hue }}>
                {initials(m.name)}
              </span>
              <div className="bubble">
                <div className="msg-meta">
                  <span className="msg-name" style={{ ["--h" as string]: hue }}>
                    {m.name}
                  </span>
                  <span className="msg-time">{formatClock(m.ts)}</span>
                  {isHost && (
                    <button
                      type="button"
                      className="msg-delete"
                      title="Delete message"
                      aria-label="Delete message"
                      onClick={() => void deleteChatMessage(m.id)}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="msg-text">{m.text}</div>
                <div className="reactions">
                  {Object.entries(m.reactions)
                    .filter(([, ids]) => ids.length > 0)
                    .map(([emoji, ids]) => (
                      <button
                        key={emoji}
                        type="button"
                        className={`reaction-chip${myId && ids.includes(myId) ? " mine" : ""}`}
                        title="Toggle reaction"
                        onClick={() => void reactToMessage(m.id, emoji)}
                      >
                        <span className="reaction-emoji">{emoji}</span>
                        <span className="reaction-count">{ids.length}</span>
                      </button>
                    ))}
                  <span className="reaction-add">
                    {QUICK_REACTIONS.map((e) => (
                      <button
                        key={e}
                        type="button"
                        className="reaction-quick"
                        title={`React with ${e}`}
                        onClick={() => void reactToMessage(m.id, e)}
                      >
                        {e}
                      </button>
                    ))}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {typingLabel && (
        <div className="typing-line" role="status">
          <span className="typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {typingLabel}
        </div>
      )}
      <form className="chat-form" onSubmit={submit}>
        <div className="emoji-wrap" ref={pickerRef}>
          <button
            type="button"
            className="emoji-btn"
            title="Emoji"
            aria-label="Emoji"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((v) => !v)}
          >
            😀
          </button>
          {pickerOpen && (
            <div className="emoji-picker" role="menu" aria-label="Emoji picker">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="emoji-cell"
                  role="menuitem"
                  onClick={() => insertEmoji(e)}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          ref={inputRef}
          className="field"
          type="text"
          maxLength={500}
          placeholder="Say something…"
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            setTyping(v.trim().length > 0);
          }}
        />
        <button type="submit" className="btn primary small">
          Send
        </button>
      </form>
    </div>
  );
}
