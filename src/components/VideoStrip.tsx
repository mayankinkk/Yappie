import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { VideoParticipant, Voice } from "../voice/useVoice";

const SNAP_MARGIN = 12;
const DRAG_THRESHOLD = 4;

function clamp(v: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(v, min), max);
}

interface VideoTileProps {
  video: VideoParticipant;
  speaking: boolean;
}

function VideoTile({ video, speaking }: VideoTileProps) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    const track = video.track;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [video.track]);
  return (
    <div
      className={`video-tile${speaking ? " speaking" : ""}`}
      data-self={video.isLocal ? "self" : "peer"}
    >
      <video ref={ref} autoPlay playsInline muted={video.isLocal} />
      <span className="video-name">{video.name}</span>
    </div>
  );
}

interface Props {
  voice: Voice;
  /** Floating overlay inside .cinema: free drag with edge snap (fullscreen). */
  floating?: boolean;
}

export default function VideoStrip({ voice, floating = false }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    dx: number;
    dy: number;
    containerW: number;
    containerH: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  // Entering/leaving fullscreen re-anchors the strip to its CSS default
  // corner (bottom-right) — no orphaned off-screen positions.
  useEffect(() => {
    if (!floating) return;
    const reset = () => setPos(null);
    document.addEventListener("fullscreenchange", reset);
    document.addEventListener("webkitfullscreenchange", reset);
    return () => {
      document.removeEventListener("fullscreenchange", reset);
      document.removeEventListener("webkitfullscreenchange", reset);
    };
  }, [floating]);

  // Tile count changes the strip's width — re-clamp so the snapped position
  // never pushes tiles outside the cinema box. Skip mid-drag (handlers clamp).
  useLayoutEffect(() => {
    if (!floating || !pos || dragging) return;
    const el = stripRef.current;
    const container = el?.closest(".cinema");
    if (!el || !container || !el.offsetWidth) return;
    const c = container.getBoundingClientRect();
    setPos((p) => {
      if (!p) return p;
      const x = clamp(p.x, 0, c.width - el.offsetWidth);
      const y = clamp(p.y, 0, c.height - el.offsetHeight);
      return x === p.x && y === p.y ? p : { x, y };
    });
  }, [floating, pos, dragging, voice.videos.length]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    const container = el?.closest(".cinema");
    if (!el || !container) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    // pos===null means CSS anchors (right/bottom) place us — measure the
    // current visual position and continue from it with zero jump.
    const cur = pos ?? { x: eRect.left - cRect.left, y: eRect.top - cRect.top };
    dragRef.current = {
      dx: e.clientX - cRect.left - cur.x,
      dy: e.clientY - cRect.top - cur.y,
      containerW: cRect.width,
      containerH: cRect.height,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    setPos(cur);
    setDragging(true);
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = stripRef.current;
    if (!drag || !el || !dragging) return;
    if (
      !drag.moved &&
      Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD
    ) {
      return;
    }
    drag.moved = true;
    setPos({
      x: clamp(e.clientX - drag.dx, 0, drag.containerW - el.offsetWidth),
      y: clamp(e.clientY - drag.dy, 0, drag.containerH - el.offsetHeight),
    });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = stripRef.current;
    if (!drag || !el) return;
    dragRef.current = null;
    setDragging(false);
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (!drag.moved) return; // a tap must not reposition the window
    // Release → snap horizontally to the nearest edge (iOS-PiP style);
    // vertical position stays where it was dropped. The transition in
    // :not(.dragging) animates the snap.
    setPos((p) => {
      if (!p) return p;
      const centerX = p.x + el.offsetWidth / 2;
      const x =
        centerX < drag.containerW / 2
          ? SNAP_MARGIN
          : Math.max(SNAP_MARGIN, drag.containerW - el.offsetWidth - SNAP_MARGIN);
      return { x, y: p.y };
    });
  };

  if (voice.videos.length === 0) return null;
  const speakingIds = new Set(voice.participants.filter((p) => p.speaking).map((p) => p.id));

  const style: CSSProperties | undefined =
    floating && pos
      ? { left: 0, top: 0, right: "auto", bottom: "auto", transform: `translate(${pos.x}px, ${pos.y}px)` }
      : undefined;

  return (
    <div
      ref={stripRef}
      className={`video-strip${floating ? " video-strip-float" : ""}${dragging ? " dragging" : ""}`}
      aria-label="Camera strip"
      style={style}
      onPointerDown={floating ? onPointerDown : undefined}
      onPointerMove={floating ? onPointerMove : undefined}
      onPointerUp={floating ? onPointerUp : undefined}
      onPointerCancel={floating ? onPointerUp : undefined}
    >
      {voice.videos.map((v) => (
        <VideoTile key={v.id} video={v} speaking={speakingIds.has(v.id)} />
      ))}
    </div>
  );
}
