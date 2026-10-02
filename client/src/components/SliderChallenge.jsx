import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, MoveHorizontal } from 'lucide-react';
import { useApp } from '../App.jsx';

/**
 * Proof-of-interaction slider. The user must drag the handle to a glowing
 * target zone placed at a random position. Pointer movement is sampled so the
 * server can distinguish a real human drag from a scripted/replayed request.
 *
 * onSolved({ id, pos, moves, duration }) is called with the proof payload.
 */
export default function SliderChallenge({ onSolved }) {
  const { t } = useApp();
  const trackRef = useRef(null);
  const startTime = useRef(0);
  const moves = useRef(0);
  const dragging = useRef(false);
  const moved = useRef(false);

  const [challenge, setChallenge] = useState(null); // { challengeId, target }
  const [pos, setPos] = useState(0); // 0–100
  const [solved, setSolved] = useState(false);

  // Fetch a fresh challenge on mount.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/challenge')
      .then((r) => r.json())
      .then((d) => !cancelled && setChallenge(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function posFromEvent(e) {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    return Math.max(0, Math.min(100, (x / rect.width) * 100));
  }

  // Start a drag only from the handle (grab it), so tapping the track does nothing.
  function begin(e) {
    if (solved || !challenge) return;
    dragging.current = true;
    moved.current = false;
    startTime.current = Date.now();
    moves.current = 0;
    // do NOT jump position on grab — the user must actually slide
  }

  function move(e) {
    if (!dragging.current || solved) return;
    if (e.cancelable) e.preventDefault(); // stop text-select/scroll while dragging
    moves.current += 1;
    moved.current = true;
    setPos(posFromEvent(e));
  }

  function end() {
    if (!dragging.current || solved || !challenge) return;
    dragging.current = false;
    const duration = Date.now() - startTime.current;
    // Solve only if the user actually dragged into the target zone.
    if (moved.current && Math.abs(pos - challenge.target) <= 4) {
      setSolved(true);
      onSolved({ id: challenge.challengeId, pos: Math.round(pos), moves: moves.current, duration });
    }
  }

  if (!challenge) {
    return (
      <div className="flex h-14 items-center justify-center rounded-2xl border border-slate-700 bg-slate-900 text-xs text-slate-500">
        …
      </div>
    );
  }

  return (
    <div className="select-none">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
        <MoveHorizontal size={13} />
        {solved ? t('challengeDone') : t('challengeSlide')}
      </p>
      <div
        ref={trackRef}
        onMouseMove={move}
        onMouseUp={end}
        onMouseLeave={end}
        onTouchMove={move}
        onTouchEnd={end}
        className="relative h-14 touch-none rounded-2xl border border-slate-700 bg-slate-900"
      >
        {/* target zone */}
        <div
          className="absolute top-1/2 h-9 w-12 -translate-x-1/2 -translate-y-1/2 rounded-xl bg-cyan-500/20 ring-2 ring-cyan-400/60"
          style={{ left: `${challenge.target}%` }}
        />
        {/* progress fill */}
        <div
          className={`absolute inset-y-0 start-0 rounded-2xl transition-colors ${solved ? 'bg-emerald-500/20' : 'bg-cyan-500/10'}`}
          style={{ width: `${pos}%` }}
        />
        {/* handle — grab and drag this */}
        <div
          onMouseDown={begin}
          onTouchStart={begin}
          className={`absolute top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-xl shadow-lg transition-colors active:cursor-grabbing ${
            solved ? 'bg-emerald-500 text-white' : 'bg-cyan-600 text-white'
          }`}
          style={{ left: `${pos}%` }}
        >
          {solved ? <CheckCircle2 size={18} /> : <MoveHorizontal size={18} />}
        </div>
      </div>
    </div>
  );
}
