import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRoom } from "../stores/room";
import { useSession } from "../stores/session";
import { initials, nameHue } from "../lib/ids";
import { formatClock } from "../lib/time";
import { messageMentions, splitMentions } from "../lib/mentions";

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
  const mentions = useRoom((s) => s.mentions);
  const participants = useRoom((s) => s.participants);
  const sendChat = useRoom((s) => s.sendChat);
  const deleteChatMessage = useRoom((s) => s.deleteChatMessage);
  const reactToMessage = useRoom((s) => s.reactToMessage);
  const hostId = useRoom((s) => s.hostId);
  const setTyping = useRoom((s) => s.setTyping);
  const typing = useRoom((s) => s.typing);
  const markChatRead = useRoom((s) => s.markChatRead);
  const roomSlowMode = useRoom((s) => s.roomSlowMode);
  const setSlowMode = useRoom((s) => s.setSlowMode);
  const code = useRoom((s) => s.code);
  const failedChat = useRoom((s) => s.failedChat);
  const dismissFailedChat = useRoom((s) => s.dismissFailedChat);
  const myId = useSession((s) => s.profile?.id);
  const myName = useSession((s) => s.profile?.name);
  const isHost = !!myId && myId === hostId;
  const [text, setText] = useState("");
  const [tick, setTick] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  /** True once the loaded history has been jumped to the bottom at least once. */
  const scrolledToLatest = useRef(false);

  // Restore the unsent draft for this room (survives a refresh; cleared on send).
  useEffect(() => {
    if (!code) return;
    let draft = "";
    try {
      draft = sessionStorage.getItem(`yappie.draft.${code}`) || "";
    } catch {
      /* storage blocked — draft just won't persist */
    }
    setText(draft);
  }, [code]);

  useEffect(() => {
    if (!failedChat) return;
    // Put a failed message's text back, but never clobber a newer draft;
    // re-persist it too, since submit already cleared the stored draft.
    if (!text) {
      setText(failedChat.text);
      saveDraft(failedChat.text);
    }
    dismissFailedChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedChat, text, code]);

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
    if (messages.length === 0) {
      scrolledToLatest.current = false;
      return;
    }
    // After a refresh/rejoin the history loads into an empty list at
    // scrollTop 0 — the near-bottom check would leave you reading the
    // oldest messages. Jump to the latest once, then follow normally.
    if (!scrolledToLatest.current) {
      scrolledToLatest.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Local ticker so peers' typing indicators expire without a presence event.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  function saveDraft(v: string) {
    if (!code) return;
    try {
      if (v) sessionStorage.setItem(`yappie.draft.${code}`, v);
      else sessionStorage.removeItem(`yappie.draft.${code}`);
    } catch {
      /* storage blocked — draft just won't persist */
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    sendChat(text);
    setText("");
    saveDraft("");
    setTyping(false);
    const el = listRef.current;
    if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  }

  void tick;

  // Slow mode: seconds left before *I* may send again (host is exempt).
  let cooling = 0;
  if (roomSlowMode > 0 && !isHost && myId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].senderId === myId) {
        cooling = Math.max(0, Math.ceil((messages[i].ts + roomSlowMode * 1000 - Date.now()) / 1000));
        break;
      }
    }
  }

  function insertEmoji(e: string) {
    const next = (text + e).slice(0, 500);
    setText(next);
    saveDraft(next);
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

  // Names people can be @mentioned by: everyone present plus me.
  const mentionNames = participants.map((p) => p.name).concat(myName ? [myName] : []);

  return (
    <div className="card chat-card">
      <div className="card-head">
        <span>Chat</span>
        {isHost && (
          <select
            className="slow-select"
            title="Slow mode — min seconds between one person's messages"
            aria-label="Chat slow mode"
            value={[0, 3, 5, 10].includes(roomSlowMode) ? roomSlowMode : 0}
            onChange={(e) => void setSlowMode(Number(e.target.value))}
          >
            <option value={0}>No slow</option>
            <option value={3}>Slow 3s</option>
            <option value={5}>Slow 5s</option>
            <option value={10}>Slow 10s</option>
          </select>
        )}
        {!isHost && roomSlowMode > 0 && (
          <span className="slow-label">Slow {roomSlowMode}s</span>
        )}
        {mentions > 0 ? (
          <span className="unread-pill mention-pill" title="Messages that @mention you">
            @{mentions}
          </span>
        ) : (
          unread > 0 && <span className="unread-pill">{unread}</span>
        )}
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
          const segments = splitMentions(m.text, mentionNames);
          const hasMention = segments.some((seg) => seg.mention);
          const hitsYou = !mine && messageMentions(m.text, myName);
          return (
            <div
              key={m.id}
              className={`msg${mine ? "mine" : ""}${hasMention ? " mentioned" : ""}${
                hitsYou ? " mention-you" : ""
              }`}
            >
                <span className={`avatar${m.avatar ? " emoji" : ""}`} style={{ ["--h" as string]: hue }}>
                  {m.avatar || initials(m.name)}
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
                  <div className="msg-text">
                    {hasMention
                      ? segments.map((seg, i) =>
                          seg.mention ? (
                            <span key={i} className="mention">
                              {seg.text}
                            </span>
                          ) : (
                            <span key={i}>{seg.text}</span>
                          ),
                        )
                      : m.text}
                  </div>
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
          disabled={cooling > 0}
          placeholder={cooling > 0 ? `Slow mode — ${cooling}s` : "Say something…"}
          value={text}
          onFocus={() => inputRef.current?.scrollIntoView({ block: "nearest" })}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            saveDraft(v);
            setTyping(v.trim().length > 0);
          }}
        />
        <button type="submit" className="btn primary small" disabled={cooling > 0}>
          Send
        </button>
      </form>
    </div>
  );
}
