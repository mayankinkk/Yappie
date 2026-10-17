import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRoom } from "../stores/room";
import { useSession } from "../stores/session";
import { initials, nameHue } from "../lib/ids";
import { formatClock } from "../lib/time";

export default function Chat() {
  const messages = useRoom((s) => s.messages);
  const unread = useRoom((s) => s.unread);
  const sendChat = useRoom((s) => s.sendChat);
  const markChatRead = useRoom((s) => s.markChatRead);
  const myId = useSession((s) => s.profile?.id);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    sendChat(text);
    setText("");
    const el = listRef.current;
    if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  }

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
                </div>
                <div className="msg-text">{m.text}</div>
              </div>
            </div>
          );
        })}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input
          className="field"
          type="text"
          maxLength={500}
          placeholder="Say something…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn primary small">
          Send
        </button>
      </form>
    </div>
  );
}
