import { useEffect, useRef, useState } from "react";

export interface Segment {
  label: string;
  /** Share of the circle, 0..1. The gift's share is the real odds, not a guess. */
  share: number;
  gift?: boolean;
}

/**
 * Builds the wheel's segments so that the gold arc is exactly the clinic's real
 * chance of the gift.
 *
 * A wheel with one slice per chance would be unreadable at twenty and absurd at
 * fifty, and a wheel with a fat, pretty jackpot slice would be a lie. Sizing the
 * gold arc at gifts/chances keeps the picture honest: if three of twenty win, the
 * gold is fifteen percent of the circle and it looks like fifteen percent.
 */
export function segmentsFor(gifts: number, chances: number, giftLabel: string, offers: string[]): Segment[] {
  const giftShare = chances > 0 ? Math.min(1, Math.max(0, gifts / chances)) : 0;
  const rest = 1 - giftShare;
  const list = offers.length > 0 ? offers : ["New Year offer"];
  const each = rest / list.length;
  return [
    { label: giftLabel, share: giftShare, gift: true },
    ...list.map((label) => ({ label, share: each })),
  ].filter((s) => s.share > 0.0001);
}

const TAU = Math.PI * 2;

/** A wheel slice is about eighteen characters wide at this radius. Past that the
 *  label collides with the one beside it, which is worse than an ellipsis. */
function short(label: string) {
  const words = label.replace(/^Free /, "").replace(/ the /, " ");
  return words.length > 18 ? `${words.slice(0, 17)}…` : words;
}
const polar = (cx: number, cy: number, r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;

function arcPath(cx: number, cy: number, r: number, from: number, to: number) {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  const large = to - from > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

// Greens for the offers; gold is reserved for the gift so the eye finds it first.
const OFFER_FILLS = ["#0e5c3f", "#12704c", "#0b4a33", "#146b4a", "#0d5539", "#117a52"];

export function Wheel({
  segments,
  landOn,
  spinning,
  onRest,
}: {
  segments: Segment[];
  /** Index of the segment the server decided on. Null until it has answered. */
  landOn: number | null;
  spinning: boolean;
  onRest: () => void;
}) {
  const [angle, setAngle] = useState(0);
  const settled = useRef(false);

  useEffect(() => {
    if (!spinning || landOn == null || settled.current) return;
    settled.current = true;
    // Centre of the winning slice, brought under the needle at twelve o'clock,
    // plus six whole turns so it reads as a spin rather than a jump.
    let start = 0;
    for (let i = 0; i < landOn; i++) start += segments[i].share;
    const centre = start + segments[landOn].share / 2;
    const target = 360 * 6 + (360 - centre * 360);
    setAngle(target);
    const t = setTimeout(onRest, 5500);
    return () => clearTimeout(t);
  }, [spinning, landOn, segments, onRest]);

  const R = 150;
  const C = 160;
  let acc = -Math.PI / 2; // start at twelve o'clock so the needle reads true

  return (
    <div className="enk-wheel-wrap">
      <svg className="enk-needle" width="34" height="30" viewBox="0 0 34 30" aria-hidden="true">
        <path d="M17 29 L3 2 h28 Z" fill="#c1272d" />
        <circle cx="17" cy="7" r="3.2" fill="#fffdf7" />
      </svg>
      <svg
        className="enk-wheel"
        width="320"
        height="320"
        viewBox="0 0 320 320"
        style={{ transform: `rotate(${angle}deg)` }}
        role="img"
        aria-label={`A wheel of ${segments.length} prizes`}
      >
        <circle cx={C} cy={C} r={R + 7} fill="#0b3325" />
        {segments.map((s, i) => {
          const from = acc;
          const to = acc + s.share * TAU;
          acc = to;
          const mid = (from + to) / 2;
          const [tx, ty] = polar(C, C, R * 0.6, mid);
          const wide = s.share > 0.085;
          // Laid along the radius, a label reads outward on the right of the wheel
          // and upside down on the left, so the left half is turned through 180°.
          const deg = ((mid * 180) / Math.PI + 360) % 360;
          const flip = deg > 90 && deg < 270;
          return (
            <g key={s.label + i}>
              <path
                d={arcPath(C, C, R, from, to)}
                fill={s.gift ? "#f5c518" : OFFER_FILLS[i % OFFER_FILLS.length]}
                stroke="#0b3325"
                strokeWidth="1.5"
              />
              {wide && (
                <text
                  x={tx}
                  y={ty}
                  fill={s.gift ? "#10261c" : "#fffdf7"}
                  fontSize={s.gift ? 15 : 10}
                  fontWeight={s.gift ? 800 : 600}
                  letterSpacing={s.gift ? 0.6 : 0}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  transform={`rotate(${deg + (flip ? 180 : 0)} ${tx} ${ty})`}
                >
                  {s.gift ? "FREE" : short(s.label)}
                </text>
              )}
            </g>
          );
        })}
        <circle cx={C} cy={C} r="26" fill="#fffdf7" stroke="#0b3325" strokeWidth="2" />
        <circle cx={C} cy={C} r="9" fill="#f5c518" />
      </svg>
    </div>
  );
}
