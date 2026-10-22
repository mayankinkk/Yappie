import { useEffect, useRef } from "react";
import type { VideoParticipant, Voice } from "../voice/useVoice";

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
    <div className={`video-tile${speaking ? " speaking" : ""}`} data-self={video.isLocal ? "self" : "peer"}>
      <video ref={ref} autoPlay playsInline muted={video.isLocal} />
      <span className="video-name">{video.name}</span>
    </div>
  );
}

interface Props {
  voice: Voice;
}

export default function VideoStrip({ voice }: Props) {
  if (voice.videos.length === 0) return null;
  const speakingIds = new Set(voice.participants.filter((p) => p.speaking).map((p) => p.id));
  return (
    <div className="video-strip" aria-label="Camera strip">
      {voice.videos.map((v) => (
        <VideoTile key={v.id} video={v} speaking={speakingIds.has(v.id)} />
      ))}
    </div>
  );
}
