/** Stylized mini-preview of a watch room for the landing card. */
export default function LandingArt() {
  return (
    <svg
      className="landing-art"
      viewBox="0 0 320 118"
      role="img"
      aria-label="A watch room: synced video, drift pill, friends chatting and reacting"
    >
      <rect x="0.5" y="0.5" width="319" height="117" rx="12" fill="#24201d" stroke="#3a352f" />
      {/* video tile */}
      <rect x="12" y="12" width="196" height="78" rx="8" fill="#1c1917" stroke="#3a352f" />
      <polygon points="96,36 96,66 124,51" fill="#f59e0b" />
      {/* seek bar */}
      <rect x="22" y="76" width="176" height="4" rx="2" fill="#3a352f" />
      <rect x="22" y="76" width="96" height="4" rx="2" fill="#f59e0b" />
      {/* sync pill */}
      <rect x="138" y="18" width="58" height="14" rx="7" fill="#24201d" stroke="#3f8f5a" />
      <circle cx="147" cy="25" r="2.5" fill="#7fd8a0" />
      <text x="153" y="28.5" fontSize="8" fill="#7fd8a0" fontFamily="ui-monospace, monospace">
        sync
      </text>
      {/* chat bubbles */}
      <rect x="220" y="14" width="88" height="28" rx="8" fill="#1c1917" stroke="#3a352f" />
      <circle cx="232" cy="24" r="5" fill="#f59e0b" />
      <rect x="242" y="20" width="54" height="4" rx="2" fill="#57534e" />
      <rect x="242" y="28" width="38" height="4" rx="2" fill="#44403c" />
      <rect x="232" y="50" width="76" height="28" rx="8" fill="#1c1917" stroke="#3a352f" />
      <circle cx="244" cy="60" r="5" fill="#34d399" />
      <rect x="254" y="56" width="42" height="4" rx="2" fill="#57534e" />
      <rect x="254" y="64" width="30" height="4" rx="2" fill="#44403c" />
      {/* floating reaction */}
      <text x="276" y="98" fontSize="13">
        ❤️
      </text>
      {/* watchers */}
      <circle cx="30" cy="100" r="7" fill="#f59e0b" />
      <circle cx="46" cy="100" r="7" fill="#34d399" />
      <circle cx="62" cy="100" r="7" fill="#60a5fa" />
      <text x="76" y="104" fontSize="9" fill="#a9a29a" fontFamily="ui-monospace, monospace">
        3 watching
      </text>
    </svg>
  );
}
