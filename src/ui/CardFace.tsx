import { ArrowLeftRight, Ban, Check, RotateCcw, Sparkles } from "lucide-react";
import type { CSSProperties, MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { Card, Color } from "./types";

const icon = (card: Card) => {
  if (card.kind === "skip") return <Ban strokeWidth={3.2} />;
  if (card.kind === "reverse") return <RotateCcw strokeWidth={3.2} />;
  if (card.kind === "draw2") return <span className="action-number">+2</span>;
  if (card.kind === "draw4") return <span className="action-number">+4</span>;
  if (card.kind === "wild") return <ArrowLeftRight strokeWidth={3.2} />;
  return <span className="pip-number">{card.value}</span>;
};

export function CardFace({ card, onClick, selected = false, disabled = false, back = false, small = false }: {
  card?: Card; onClick?: (event: MouseEvent<HTMLButtonElement>) => void; selected?: boolean; disabled?: boolean; back?: boolean; small?: boolean;
}) {
  if (back || !card) return <div className={`playing-card card-back ${small ? "card-small" : ""}`} aria-label="Face-down card"><span><Sparkles size={20} /> Shuffle!</span></div>;
  const faceColor = card.color === "wild" ? "#151515" : ({ red: "#ed1c24", yellow: "#ffda00", green: "#00a94f", blue: "#0072bc" } as const)[card.color];
  return <button type="button" data-card-id={card.id} className={`playing-card card-${card.color} effect-${card.kind} ${selected ? "selected" : ""} ${small ? "card-small" : ""}`} style={{ "--card-color": faceColor, backgroundColor: faceColor } as CSSProperties} onClick={onClick} disabled={disabled} aria-label={`${card.color} ${card.kind === "number" ? card.value : card.kind}`}>
    <span className="card-corner corner-top">{card.kind === "number" ? card.value : icon(card)}</span>
    <span className={`card-mark ${card.color === "wild" ? "wild-mark" : ""}`}>{icon(card)}</span>
    <span className="card-corner corner-bottom">{card.kind === "number" ? card.value : icon(card)}</span>
  </button>;
}

export function ColorPicker({ onChoose, onCancel }: { onChoose: (color: Color) => void; onCancel?: () => void }) {
  const [picked, setPicked] = useState<Color | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return <div className="color-picker-wrap" role="dialog" aria-modal="true" aria-label="Choose a color">
    <div className="color-picker wild-picker"><div className="color-picker-title">Wild! Choose a color</div><div className="color-grid">
      {(["red", "yellow", "green", "blue"] as Color[]).map((color) => <button key={color} className={`color-choice ${color} ${picked === color ? "picked" : ""}`} disabled={!!picked && picked !== color} onClick={() => { if (picked) return; setPicked(color); timer.current = window.setTimeout(() => onChoose(color), 520); }} aria-label={`Choose ${color}`}><span>{picked === color ? <><Check size={17} /> Picked!</> : color}</span></button>)}
    </div>{onCancel && <button className="cancel-color" onClick={onCancel}>Cancel</button>}</div>
  </div>;
}
