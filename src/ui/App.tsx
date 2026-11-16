import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { ArrowLeft, ArrowRight, Bell, Check, ChevronRight, CircleHelp, Copy, Crown, DoorOpen, Gamepad2, LoaderCircle, LockKeyhole, Plus, RefreshCw, Sparkles, Users, Wifi, X } from "lucide-react";
import { CardFace, ColorPicker } from "./CardFace";
import type { Card, Color, RoomListing, RoomView } from "./types";

const keyPlayer = "uno-party.player";
const keyName = "uno-party.name";
const colorNames: Record<Color, string> = { red: "Tomato", yellow: "Lemon", green: "Mint", blue: "Berry" };
const canPlayCard = (card: Card, game: NonNullable<RoomView["game"]>) => {
  if (game.pendingDraw > 0) return card.kind === "draw2" || card.kind === "draw4";
  const top = game.discard;
  return card.kind === "wild" || card.kind === "draw4" || card.color === game.currentColor ||
    (card.kind === top?.kind && card.kind !== "number") ||
    (card.kind === "number" && top?.kind === "number" && card.value === top.value);
};

function flyCardToDiscard(origin: HTMLButtonElement | null) {
  const target = document.querySelector<HTMLElement>(".discard-area > .playing-card");
  if (!origin || !target) return;
  const from = origin.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const ghost = origin.cloneNode(true) as HTMLButtonElement;
  ghost.classList.remove("selected");
  ghost.classList.add("card-flight-ghost");
  Object.assign(ghost.style, {
    position: "fixed", left: `${from.left}px`, top: `${from.top}px`,
    width: `${from.width}px`, height: `${from.height}px`, margin: "0", zIndex: "80",
    pointerEvents: "none", transform: "none",
  });
  document.body.append(ghost);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 20 : 560;
  const animation = ghost.animate([
    { transform: "translate(0, 0) rotate(0) scale(1)", opacity: 1, offset: 0 },
    { transform: `translate(${dx * .48}px, ${dy * .48 - 46}px) rotate(12deg) scale(1.1)`, opacity: 1, offset: .56 },
    { transform: `translate(${dx * .96}px, ${dy * .96}px) rotate(20deg) scale(.94)`, opacity: 1, offset: .92 },
    { transform: `translate(${dx}px, ${dy}px) rotate(6deg) scale(1)`, opacity: 1, offset: 1 },
  ], { duration, easing: "cubic-bezier(.2,.75,.22,1)", fill: "forwards" });
  animation.onfinish = () => {
    ghost.remove();
    if (duration > 20 && target.isConnected) target.animate([
      { transform: "rotate(6deg) scale(1)" },
      { transform: "rotate(-2deg) scale(1.08)" },
      { transform: "rotate(6deg) scale(1)" },
    ], { duration: 250, easing: "cubic-bezier(.2,.8,.2,1)" });
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "The party server is taking a little break.");
  return data;
}

export default function App() {
  const [playerId, setPlayerId] = useState(() => localStorage.getItem(keyPlayer) || "");
  const [username, setUsername] = useState(() => localStorage.getItem(keyName) || "");
  const [nameDraft, setNameDraft] = useState(username);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [rooms, setRooms] = useState<RoomListing[]>([]);
  const [roomName, setRoomName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [inviteCode, setInviteCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [copied, setCopied] = useState(false);
  const wildCardOrigin = useRef<HTMLButtonElement | null>(null);

  const refreshRooms = useCallback(async () => {
    try { setRooms(await request<RoomListing[]>("/api/rooms")); } catch { /* Lobby refresh recovers on the next tick. */ }
  }, []);

  useEffect(() => {
    if (!playerId) return;
    void refreshRooms();
    const timer = window.setInterval(() => void refreshRooms(), 3500);
    return () => window.clearInterval(timer);
  }, [playerId, refreshRooms]);

  useEffect(() => {
    if (!room || !playerId) return;
    let active = true;
    let socket: WebSocket | undefined;
    let retry = 0;
    let retryTimer = 0;
    const open = () => {
      if (!active) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/ws/${room.id}?playerId=${encodeURIComponent(playerId)}`);
      socket.onopen = () => { retry = 0; setConnected(true); };
      socket.onmessage = (event) => {
        try { const message = JSON.parse(event.data); if (message.type === "state") setRoom(message.state as RoomView); } catch { /* Ignore malformed sync frames. */ }
      };
      socket.onclose = () => {
        setConnected(false);
        if (active) retryTimer = window.setTimeout(open, Math.min(6000, 700 + retry++ * 500));
      };
      socket.onerror = () => socket?.close();
    };
    open();
    const poll = window.setInterval(async () => {
      try { const state = await request<RoomView>(`/api/rooms/${room.id}/state?playerId=${encodeURIComponent(playerId)}`); if (active) setRoom(state); } catch { /* WebSocket and HTTP retry independently. */ }
    }, 8000);
    return () => { active = false; window.clearInterval(poll); window.clearTimeout(retryTimer); socket?.close(); setConnected(false); };
  }, [room?.id, playerId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2300);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const me = useMemo(() => room?.players.find((p) => p.id === playerId), [room, playerId]);

  const setGuest = (event: FormEvent) => {
    event.preventDefault();
    const clean = nameDraft.trim().replace(/\s+/g, " ").slice(0, 22);
    if (!clean) return setError("Pop in a nickname first!");
    const id = playerId || crypto.randomUUID();
    localStorage.setItem(keyPlayer, id); localStorage.setItem(keyName, clean);
    setPlayerId(id); setUsername(clean); setError("");
  };

  const updateRoom = (state: RoomView) => { setRoom(state); setError(""); };
  const createRoom = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const created = await request<RoomListing>("/api/rooms", { method: "POST", body: JSON.stringify({ playerId, hostName: username, name: roomName, visibility }) });
      const state = await request<RoomView>(`/api/rooms/${created.id}/state?playerId=${encodeURIComponent(playerId)}`);
      updateRoom(state); setCreating(false); setRoomName(""); await refreshRooms();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create your party."); } finally { setBusy(false); }
  };

  const joinRoom = async (id: string, code?: string) => {
    setBusy(true); setJoining(id); setError("");
    try {
      const state = await request<RoomView>(`/api/rooms/${id}/join`, { method: "POST", body: JSON.stringify({ playerId, name: username, code }) });
      updateRoom(state); setInviteCode(""); await refreshRooms();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not join that party."); } finally { setBusy(false); setJoining(""); }
  };

  const joinByCode = async (event: FormEvent) => {
    event.preventDefault();
    const code = inviteCode.trim().toUpperCase();
    if (!code) return;
    setBusy(true); setError("");
    try { updateRoom(await request<RoomView>("/api/join", { method: "POST", body: JSON.stringify({ playerId, name: username, code }) })); setInviteCode(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not join that party."); }
    finally { setBusy(false); }
  };

  const postAction = async (type: string, extra: Record<string, unknown> = {}, route = "action") => {
    if (!room) return;
    setBusy(true); setError("");
    try { updateRoom(await request<RoomView>(`/api/rooms/${room.id}/${route}`, { method: "POST", body: JSON.stringify({ playerId, action: { type, ...extra } }) })); }
    catch (e) { setError(e instanceof Error ? e.message : "That move did not work."); }
    finally { setBusy(false); }
  };

  const playCard = (card: Card, origin: HTMLButtonElement) => {
    if (card.kind === "wild" || card.kind === "draw4") {
      wildCardOrigin.current = origin;
      setColorFor(card.id);
    } else {
      flyCardToDiscard(origin);
      void postAction("play", { cardId: card.id });
    }
  };
  const chooseColor = (color: Color) => {
    const card = room?.players.find((player) => player.id === playerId)?.hand?.find((item) => item.id === colorFor);
    if (colorFor && card) {
      flyCardToDiscard(wildCardOrigin.current);
      void postAction("play", { cardId: colorFor, color });
    }
    wildCardOrigin.current = null;
    setColorFor(null);
  };
  const copyInvite = async () => {
    if (!room) return;
    try { await navigator.clipboard.writeText(`${location.origin}/?party=${room.code}`); setCopied(true); setToast("Party invite copied!"); setTimeout(() => setCopied(false), 1700); }
    catch { setToast(`Invite code: ${room.code}`); }
  };

  useEffect(() => {
    const code = new URLSearchParams(location.search).get("party");
    if (code) setInviteCode(code.toUpperCase());
  }, []);

  if (!playerId) return <main className="welcome-screen">
    <div className="welcome-sparkle sparkle-one">✦</div><div className="welcome-sparkle sparkle-two">✦</div>
    <div className="welcome-art" aria-hidden="true"><div className="mini-card mini-red">7</div><div className="mini-card mini-yellow">↻</div><div className="mini-card mini-blue">+2</div><div className="mini-card mini-green">3</div></div>
    <section className="welcome-card"><div className="brand-mark"><span className="brand-orbit">↗</span></div><p className="eyebrow">A little friendly chaos</p><h1>Shuffle up,<br /><span>buttercup.</span></h1><p className="welcome-copy">Pick a nickname, find your people, and make your move.</p>
      <form onSubmit={setGuest} className="welcome-form"><label htmlFor="nickname">Your player name</label><input id="nickname" value={nameDraft} maxLength={22} onChange={(e) => setNameDraft(e.target.value)} placeholder="e.g. Captain Pickles" autoComplete="nickname" autoFocus /><button className="button button-primary button-wide" type="submit">Let’s play <ArrowRight size={18} /></button></form>
      {error && <p className="inline-error">{error}</p>}<div className="guest-note"><Sparkles size={14} /> Guest play · no account needed</div>
    </section>
    <div className="welcome-foot">A colorful card party for your favorite people</div>
  </main>;

  if (room) return <GameRoomScreen room={room} me={me} connected={connected} busy={busy} error={error} toast={toast} colorFor={colorFor} setColorFor={setColorFor} chooseColor={chooseColor} copyInvite={copyInvite} copied={copied} onAction={postAction} onPlay={playCard} onBack={() => { setRoom(null); void refreshRooms(); }} />;

  const filteredRooms = rooms.filter((entry) => entry.status === "waiting");
  return <div className="lobby-page">
    <header className="topbar"><button className="brand brand-button" onClick={() => { setRoom(null); }}><span className="brand-dot">✦</span><span>shuffle<span className="brand-soft">club</span></span></button><div className="topbar-right"><span className="online-pill"><span className="online-dot" /> Lobby is open</span><button className="profile-chip" onClick={() => { setNameDraft(username); setPlayerId(""); localStorage.removeItem(keyPlayer); }}><span className="avatar avatar-coral">{username.charAt(0).toUpperCase()}</span><span>{username}</span><ChevronRight size={15} /></button></div></header>
    <main className="lobby-content">
      <div className="lobby-heading"><div><p className="eyebrow">Your next favorite game night</p><h1>Find your <span>party.</span></h1><p>Bring your best friends. Leave your luck at the door.</p></div><div className="heading-sticker"><div>2–4</div><span>players<br />per party</span></div></div>
      <section className="lobby-grid">
        <div className="party-panel create-panel"><div className="panel-kicker"><span className="kicker-icon kicker-yellow"><Plus size={17} /></span> Your party, your rules</div><h2>Start a new<br />card party</h2><p>Pick a name, set it to public or private, then invite up to three friends.</p>
          {!creating ? <button className="button button-dark button-wide create-cta" onClick={() => setCreating(true)}>Create a party <ArrowRight size={17} /></button> : <form onSubmit={createRoom} className="create-form"><label htmlFor="party-name">Party name</label><input id="party-name" value={roomName} maxLength={32} onChange={(e) => setRoomName(e.target.value)} placeholder={`${username}’s game night`} autoFocus /><div className="visibility-row"><button type="button" className={`visibility-option ${visibility === "public" ? "chosen" : ""}`} onClick={() => setVisibility("public")}><Users size={16} /><span>Public</span></button><button type="button" className={`visibility-option ${visibility === "private" ? "chosen" : ""}`} onClick={() => setVisibility("private")}><LockKeyhole size={15} /><span>Private</span></button></div><div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setCreating(false)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : "Create party"}</button></div></form>}
          <div className="panel-deco"><div className="deco-card deco-card-yellow">↻</div><div className="deco-card deco-card-blue">+2</div><div className="deco-card deco-card-coral">8</div></div>
        </div>
        <div className="party-panel join-panel"><div className="panel-kicker"><span className="kicker-icon kicker-coral"><DoorOpen size={16} /></span> Got an invite?</div><h2>Join by<br />party code</h2><p>Ask your friend for their four-letter party code.</p><form className="code-form" onSubmit={joinByCode}><input aria-label="Party code" value={inviteCode} maxLength={8} onChange={(e) => setInviteCode(e.target.value.toUpperCase())} placeholder="ABCD" /><button aria-label="Join party" className="button button-coral" disabled={busy}><ArrowRight size={19} /></button></form><div className="join-note"><CircleHelp size={14} /> Codes are case-insensitive</div></div>
      </section>
      {error && <div className="error-banner"><X size={17} /> {error}</div>}
      <section className="available-section"><div className="available-header"><div><div className="section-kicker">THE OPEN TABLE</div><h2>Parties looking for players <span className="count-bubble">{filteredRooms.length}</span></h2></div><button className="refresh-button" onClick={() => void refreshRooms()} aria-label="Refresh parties"><RefreshCw size={17} /></button></div>
        {filteredRooms.length ? <div className="room-list">{filteredRooms.map((entry) => <article className="room-row" key={entry.id}><div className="room-avatar-stack"><span className="room-ball ball-red">{entry.name.charAt(0)}</span><span className="room-ball ball-yellow"><Sparkles size={13} /></span></div><div className="room-main"><h3>{entry.name}</h3><p>Hosted by <strong>{entry.hostName}</strong> · {entry.visibility === "private" ? "Invite party" : "Open party"}</p></div><div className="room-seats"><Users size={15} /><span>{entry.players}/{entry.maxPlayers}</span></div><button className="button button-outline join-button" disabled={busy || entry.players >= 4} onClick={() => void joinRoom(entry.id, inviteCode || undefined)}>{joining === entry.id ? <LoaderCircle className="spin" size={17} /> : "Join party"}<ChevronRight size={15} /></button></article>)}</div> : <div className="empty-lobby"><div className="empty-symbol"><Gamepad2 size={25} /></div><div><h3>It’s quiet in here… for now.</h3><p>Start a party and your friends will find their way in.</p></div></div>}
      </section>
      <footer className="lobby-footer"><span><Sparkles size={14} /> Made for real people and questionable color choices</span><span>Best enjoyed with friends</span></footer>
    </main>
    {toast && <div className="toast-message"><Check size={16} />{toast}</div>}
  </div>;
}

function GameRoomScreen({ room, me, connected, busy, error, toast, colorFor, setColorFor, chooseColor, copyInvite, copied, onAction, onPlay, onBack }: {
  room: RoomView; me?: RoomView["players"][number]; connected: boolean; busy: boolean; error: string; toast: string;
  colorFor: string | null; setColorFor: (value: string | null) => void; chooseColor: (color: Color) => void; copyInvite: () => void; copied: boolean;
  onAction: (type: string, extra?: Record<string, unknown>, route?: string) => Promise<void>; onPlay: (card: Card, origin: HTMLButtonElement) => void; onBack: () => void;
}) {
  const game = room.game;
  const hand = me?.hand ?? [];
  const drawnCard = game?.drawnCardId ? hand.find((card) => card.id === game.drawnCardId) : undefined;
  const drawnCardPlayable = !!(drawnCard && game && canPlayCard(drawnCard, game));
  const isMyTurn = !!me?.isCurrent;
  const host = room.hostId === room.you;
  const activePlayer = room.players.find((player) => player.isCurrent);
  const winner = room.players.find((player) => player.id === game?.winnerId);
  const unoTarget = room.players.find((player) => player.cardCount === 1 && !player.unoCalled && player.id !== room.you);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [dealing, setDealing] = useState(false);
  const [colorChanging, setColorChanging] = useState(false);
  const wasWaiting = useRef(room.status === "waiting");
  const previousColor = useRef(game?.currentColor);
  const [visibleNotices, setVisibleNotices] = useState<NonNullable<RoomView["game"]>["notices"]>([]);
  const noticesKey = game?.notices?.map((notice) => notice.id).join("|") ?? "";

  useEffect(() => {
    if (room.status === "waiting") { wasWaiting.current = true; return; }
    if (room.status === "playing" && wasWaiting.current) {
      wasWaiting.current = false;
      setDealing(true);
      const timer = window.setTimeout(() => setDealing(false), 2400);
      return () => window.clearTimeout(timer);
    }
  }, [room.status]);

  useEffect(() => {
    const nextColor = game?.currentColor;
    if (previousColor.current && nextColor && previousColor.current !== nextColor) {
      setColorChanging(true);
      const timer = window.setTimeout(() => setColorChanging(false), 1200);
      previousColor.current = nextColor;
      return () => window.clearTimeout(timer);
    }
    previousColor.current = nextColor;
  }, [game?.currentColor]);

  useEffect(() => {
    if (!game?.notices?.length) { setVisibleNotices([]); return; }
    setVisibleNotices(game.notices);
    const timer = window.setTimeout(() => setVisibleNotices([]), 3100);
    return () => window.clearTimeout(timer);
  }, [noticesKey]);

  const opponents = room.players.filter((player) => player.id !== room.you);
  const seatFor = (index: number) => opponents.length === 1 ? "seat-top-center"
    : opponents.length === 2 ? (index === 0 ? "seat-top-left" : "seat-top-right")
    : (index === 0 ? "seat-left" : index === 1 ? "seat-top-center" : "seat-right");

  return <div className={`game-page ${dealing ? "dealing" : ""}`}>
    <header className="game-topbar"><button className="back-link" onClick={onBack}><ArrowLeft size={17} /> Lobby</button><div className="table-brand"><span className="brand-dot">✦</span> shuffle<span className="brand-soft">club</span></div><div className={`connection-pill ${connected ? "is-connected" : "is-waiting"}`}><span className="connection-dot" />{connected ? "Live table" : "Reconnecting"}</div></header>
    <main className="game-layout">
      <div className="game-heading"><div><p className="eyebrow">{room.visibility === "public" ? "OPEN PARTY" : "PRIVATE PARTY"} <span className="heading-dot">·</span> {room.players.length}/4 players</p><h1>{room.name}</h1></div><div className="game-heading-actions"><button className="button button-soft" onClick={copyInvite}>{copied ? <Check size={16} /> : <Copy size={15} />} {copied ? "Copied!" : `Invite · ${room.code}`}</button><button className="icon-button" aria-label="How to play" onClick={() => setRuleOpen(!ruleOpen)}><CircleHelp size={18} /></button></div></div>
      {ruleOpen && <div className="rules-popover"><button className="popover-close" onClick={() => setRuleOpen(false)} aria-label="Close rules"><X size={15} /></button><h3>Quick rules</h3><p>Match the color, number, or symbol. If you can’t play, draw one card. First player out wins.</p><p><strong>Stack it up:</strong> Any +2 or +4 can answer any draw penalty. If you have no +2 or +4, the full penalty is added automatically and your turn is skipped.</p><p>Call UNO when you’re down to one card. A Wild +4 challenge appears with a stackable + card; it checks whether the player had the previous color—it is not a way to accept the penalty.</p></div>}
      {error && <div className="error-banner game-error"><X size={17} /> {error}</div>}
      {room.status === "waiting" ? <section className="waiting-table"><div className="waiting-deco"><div className="wait-card wait-yellow">+2</div><div className="wait-card wait-blue">↻</div><div className="wait-card wait-red">5</div></div><div className="waiting-copy"><span className="waiting-tag"><span className="online-dot" /> PARTY IS OPEN</span><h2>Gather your<br /><span>game crew.</span></h2><p>Share your invite code and let the good-natured chaos begin.</p><button className="button button-primary invite-large" onClick={copyInvite}>{copied ? <Check size={18} /> : <Copy size={17} />} {copied ? "Invite copied" : `Copy invite · ${room.code}`}</button>{host && room.players.length >= 2 && <button className="button button-dark start-button" disabled={busy} onClick={() => void onAction("start", {}, "start")}>Deal the cards <ArrowRight size={17} /></button>}{host && room.players.length < 2 && <div className="waiting-hint"><Users size={16} /> Need one more player to start</div>}{!host && <div className="waiting-hint"><LoaderCircle size={15} className="spin" /> Waiting for {room.players.find((p) => p.id === room.hostId)?.name || "the host"} to deal</div>}</div><div className="waiting-players"><div className="player-list-title">AT THE TABLE <span>{room.players.length}/4</span></div>{[...room.players, ...Array.from({ length: Math.max(0, 4 - room.players.length) }, (_, index) => ({ id: `empty${index}`, name: "Open seat", connected: false, isCurrent: false, cardCount: 0, unoCalled: true }))].map((player, index) => <div className={`waiting-player ${player.id === room.you ? "self-player" : ""}`} key={player.id}><div className={`avatar ${["avatar-coral", "avatar-yellow", "avatar-green", "avatar-blue"][index]}`}>{player.name === "Open seat" ? <Plus size={15} /> : player.name.charAt(0).toUpperCase()}</div><div><strong>{player.name}</strong><small>{player.id === room.you ? "That’s you!" : player.id === room.hostId ? "Party host" : player.name === "Open seat" ? "Bring a friend" : "Ready to play"}</small></div>{player.id === room.hostId && <Crown size={16} className="host-crown" />}{player.id !== "Open seat" && <span className={`presence ${player.connected ? "present" : "away"}`} title={player.connected ? "Connected" : "Reconnecting"} />}</div>)}</div></section> : <>
        <section className="game-table" aria-label="Game table">
          <div className="table-felt"><div className="felt-glow glow-left" /><div className="felt-glow glow-right" />
            <div className="table-topline"><span className="turn-badge">{game?.status === "finished" ? "GAME OVER" : isMyTurn ? "YOUR TURN" : `${activePlayer?.name ?? "Player"}’S TURN`}</span><span className="table-round">COLOR POP · ROUND 1</span></div>
            <div className="opponents">{opponents.map((player, index) => { const step = Math.min(14, 210 / Math.max(player.cardCount - 1, 1)); return <div className={`opponent ${seatFor(index)} ${player.isCurrent ? "opponent-active" : ""}`} key={player.id}><div className={`opponent-avatar avatar-${["yellow", "coral", "green"][index]}`}>{player.name.charAt(0).toUpperCase()}<span className={`presence ${player.connected ? "present" : "away"}`} /></div><strong>{player.name}{player.id === room.hostId && <Crown size={12} className="host-crown" />}</strong><div className="opponent-cards-stack" style={{ "--stack-width": `${Math.min(240, 27 + Math.max(0, player.cardCount - 1) * step)}px` } as CSSProperties} aria-hidden="true">{Array.from({ length: player.cardCount }, (_, back) => <span className="opponent-back" style={{ "--back-index": back, "--back-step": `${step}px`, "--back-angle": `${(back - (player.cardCount - 1) / 2) * 1.5}deg` } as CSSProperties} key={back} />)}</div><div className="opponent-hand"><span className="opponent-card-count">{player.cardCount}</span><span>{player.cardCount === 1 ? "card" : "cards"}</span>{player.cardCount === 1 && !player.unoCalled && <span className="uno-alert">UNO!</span>}</div>{player.isCurrent && <span className="active-label">Playing now</span>}</div>; })}</div>
            <div className="table-game-mark" aria-hidden="true">UNO</div>
            <div className="center-play"><div className="deck-area"><button className="deck-stack" onClick={() => isMyTurn && !game?.hasDrawn && void onAction("draw")} disabled={!isMyTurn || busy || game?.status === "finished"} aria-label="Draw a card"><span className="deck-count">{game?.deckCount}</span><CardFace back /></button><span className="pile-label">DRAW PILE</span></div><div key={game?.direction} className="direction-orb"><span>{game?.direction === 1 ? "↻" : "↺"}</span></div><div className={`discard-area card-${game?.currentColor}`}><div key={game?.currentColor} className={`active-color-orb ${game?.currentColor}`} title={`Current color: ${game?.currentColor}`} /><CardFace card={game?.discard} /><span className="pile-label">DISCARD PILE</span></div>
              {game?.pendingDraw ? <div className="penalty-burst"><span className="burst-star">✦</span><strong>+{game.pendingDraw}</strong><small>STACK IT!</small></div> : null}
            </div>
            {colorChanging && <div key={`${game?.currentColor}-${colorChanging}`} className={`color-shift-burst card-${game?.currentColor}`} role="status" aria-live="polite"><span>COLOR!</span><strong>{colorNames[game?.currentColor ?? "red"]}</strong><i>✦</i></div>}
            {!!visibleNotices?.length && <div className="game-event-stack" role="status" aria-live="polite">{visibleNotices.map((notice) => <div className="game-event" key={notice.id}><span className="event-star">✦</span>{notice.text}</div>)}</div>}
            <div className="table-bottomline"><div className="color-callout"><span className={`color-dot ${game?.currentColor}`} /> {colorNames[game?.currentColor ?? "red"]} is up</div><div className="stack-rule"><span>✦</span> +2s & +4s stack together</div></div>
            {winner && <div className="winner-splash"><div className="winner-confetti">✦ ✦ ✦</div><div className="winner-card"><span>THE WINNER</span><h2>{winner.name} wins!</h2><p>Nice moves, {winner.name}. Ready for another round?</p>{host && <button className="button button-primary" disabled={busy} onClick={() => void onAction("rematch", {}, "rematch")}>Play again <RefreshCw size={16} /></button>}</div></div>}
          </div>
          <div className="hand-area"><div className="hand-header"><div><span className="hand-kicker">YOUR HAND</span><strong>{hand.length} <span>{hand.length === 1 ? "card" : "cards"}</span></strong></div><button className={`uno-button ${hand.length === 1 && !me?.unoCalled ? "uno-ready" : ""}`} disabled={hand.length !== 1 || me?.unoCalled || busy} onClick={() => void onAction("callUno")}>UNO! <Bell size={15} /></button></div>
            {game?.pendingDraw && isMyTurn && <div className="turn-prompt penalty-prompt"><span>They stacked +{game.pendingDraw} on you! Stack a +2/+4 or take the total.</span><div><button className="button button-outline button-sm" disabled={busy} onClick={() => void onAction("draw")}>Take {game.pendingDraw} <ArrowRight size={14} /></button>{game.challengeAvailable && <button className="button button-dark button-sm" title="Challenge checks if the +4 player held the previous color." disabled={busy} onClick={() => void onAction("challenge")}>Challenge +4</button>}</div></div>}
            {game?.hasDrawn && isMyTurn && <div className={`turn-prompt drawn-prompt ${drawnCardPlayable ? "drawn-can-play" : "drawn-must-pass"}`}><span>{drawnCardPlayable ? "Playable card! It’s highlighted—play it or pass." : "That card can’t match. Pass your turn."}</span><button className="button button-outline button-sm" disabled={busy} onClick={() => void onAction("pass")}>Pass turn <ArrowRight size={14} /></button></div>}
            {isMyTurn && !game?.pendingDraw && !game?.hasDrawn && game?.status === "playing" && <div className="turn-prompt quiet-prompt">Match a card—or draw one from the pile.</div>}
            {!isMyTurn && game?.status === "playing" && <div className="turn-prompt quiet-prompt">{activePlayer?.name} is up. Pick your next move…</div>}
            {unoTarget && isMyTurn && <div className="catch-uno"><span><Bell size={15} /> {unoTarget.name} forgot to call UNO!</span><button onClick={() => void onAction("catchUno", { targetId: unoTarget.id })} disabled={busy}>Catch them <ArrowRight size={14} /></button></div>}
            <div className="hand-cards" aria-label="Your cards">{hand.map((card, index) => <div className={`hand-card-wrap ${game?.hasDrawn && game.drawnCardId === card.id && drawnCardPlayable ? "drawn-playable" : ""}`} style={{ "--card-index": index, "--card-count": hand.length } as CSSProperties} key={card.id}><CardFace card={card} onClick={(event) => onPlay(card, event.currentTarget)} selected={game?.drawnCardId === card.id} disabled={!isMyTurn || busy || game?.status !== "playing" || !game || !canPlayCard(card, game) || (!!game.hasDrawn && game.drawnCardId !== card.id)} /></div>)}</div>
          </div>
        </section>
        <div className="game-players-mobile">{room.players.map((p) => <span key={p.id} className={`${p.isCurrent ? "mobile-current" : ""}`}>{p.id === room.you ? "You" : p.name} · {p.cardCount}</span>)}</div>
      </>}
      <footer className="game-footer"><span><Wifi size={13} /> Live game · synchronized with your friends</span><button onClick={() => { void onAction("", {}, "leave"); onBack(); }}>Leave party <DoorOpen size={14} /></button></footer>
    </main>
    {colorFor && <ColorPicker onChoose={(color) => { setColorChanging(true); window.setTimeout(() => setColorChanging(false), 1200); chooseColor(color); }} onCancel={() => setColorFor(null)} />}
    {toast && <div className="toast-message"><Check size={16} />{toast}</div>}
  </div>;
}
