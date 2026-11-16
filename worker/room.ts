import { DurableObject } from "cloudflare:workers";
import type { Directory } from "./directory";

type Color = "red" | "yellow" | "green" | "blue";
type Kind = "number" | "skip" | "reverse" | "draw2" | "wild" | "draw4";
type Card = { id: string; color: Color | "wild"; kind: Kind; value?: number };
type Player = { id: string; name: string; hand: Card[]; connected: boolean; disconnectedAt?: number; unoCalled: boolean };
type GameNotice = { id: string; playerId: string; count: number; reason: "draw" | "penalty" | "autoPenalty" | "uno" | "challengeSuccess" | "challengeFailed"; otherPlayerId?: string };
type Game = {
  deck: Card[]; discard: Card[]; current: number; direction: 1 | -1; color: Color; pendingDraw: number;
  challenge: null | { offenderId: string; challengerId: string; colorBefore: Color };
  hasDrawn: boolean; drawnCardId?: string; unoWindowPlayerId?: string; notices: GameNotice[]; status: "playing" | "finished"; winnerId?: string;
};
type RoomState = {
  id: string; code: string; name: string; visibility: "public" | "private"; players: Player[];
  hostId: string; status: "waiting" | "playing" | "finished"; game?: Game;
};
interface Env { DIRECTORY: DurableObjectNamespace<Directory>; }

const COLORS: Color[] = ["red", "yellow", "green", "blue"];
const OTHER = (message: string, status = 400) => Response.json({ error: message }, { status });
const wrap = (index: number, length: number) => ((index % length) + length) % length;
const cleanName = (name: unknown, fallback = "Player") => (typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, 22) : "") || fallback;

function makeDeck(): Card[] {
  const cards: Card[] = [];
  let id = 0;
  for (const color of COLORS) {
    cards.push({ id: `c${id++}`, color, kind: "number", value: 0 });
    for (let value = 1; value <= 9; value++) for (let copy = 0; copy < 2; copy++) cards.push({ id: `c${id++}`, color, kind: "number", value });
    for (const kind of ["skip", "reverse", "draw2"] as const) for (let copy = 0; copy < 2; copy++) cards.push({ id: `c${id++}`, color, kind });
  }
  for (let copy = 0; copy < 4; copy++) {
    cards.push({ id: `c${id++}`, color: "wild", kind: "wild" });
    cards.push({ id: `c${id++}`, color: "wild", kind: "draw4" });
  }
  return cards;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const rand = new Uint32Array(1);
    crypto.getRandomValues(rand);
    const j = rand[0] % (i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function playable(card: Card, game: Game): boolean {
  if (game.pendingDraw > 0) return card.kind === "draw2" || card.kind === "draw4";
  const top = game.discard.at(-1)!;
  return card.kind === "wild" || card.kind === "draw4" || card.color === game.color || (card.kind === top.kind && card.kind !== "number") || (card.kind === "number" && top.kind === "number" && card.value === top.value);
}

function nextIndex(game: Game, count: number, steps = 1) { return wrap(game.current + game.direction * steps, count); }

export class GameRoom extends DurableObject<Env> {
  private operationQueue: Promise<void> = Promise.resolve();

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<RoomState | undefined> { return this.ctx.storage.get<RoomState>("room"); }
  private async write(state: RoomState) {
    await this.ctx.storage.put("room", state);
    const deadlines = state.players.filter((player) => !player.connected && player.disconnectedAt).map((player) => player.disconnectedAt! + 60_000);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else await this.ctx.storage.deleteAlarm();
    await this.updateDirectory(state);
  }

  fetch(request: Request): Promise<Response> {
    return this.serial(() => this.handleRequest(request));
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/create" && request.method === "POST") {
      if (await this.read()) return OTHER("That room already exists.", 409);
      const body = await request.json() as { id: string; code: string; name: string; hostName: string; playerId: string; visibility: "public" | "private" };
      const state: RoomState = {
        id: body.id, code: body.code, name: cleanName(body.name, "Color Pop Party"), visibility: body.visibility,
        hostId: body.playerId,
        players: [{ id: body.playerId, name: cleanName(body.hostName), hand: [], connected: true, unoCalled: true }],
        status: "waiting",
      };
      await this.write(state);
      return Response.json(this.listing(state), { status: 201 });
    }
    const state = await this.read();
    if (!state) return OTHER("Party not found.", 404);
    if (url.pathname === "/state" && request.method === "GET") {
      const playerId = url.searchParams.get("playerId") ?? "";
      if (!state.players.some((p) => p.id === playerId)) return OTHER("You are not in this party.", 403);
      if (this.resolveUnstackablePenalty(state)) {
        await this.write(state);
        this.broadcast(state);
      }
      return Response.json(this.view(state, playerId));
    }
    if (url.pathname === "/join" && request.method === "POST") {
      const body = await request.json() as { playerId: string; name: string; code?: string };
      if (!body.playerId) return OTHER("Create a guest profile first.");
      const present = state.players.find((p) => p.id === body.playerId);
      if (present) {
        present.connected = true; delete present.disconnectedAt;
      } else {
        if (state.status !== "waiting") return OTHER("This party has already started.", 409);
        if (state.visibility === "private" && body.code?.toUpperCase() !== state.code) return OTHER("That invite code did not match.", 403);
        if (state.players.length >= 4) return OTHER("This party is full.", 409);
        state.players.push({ id: body.playerId, name: cleanName(body.name), hand: [], connected: true, unoCalled: true });
      }
      await this.write(state);
      this.broadcast(state);
      return Response.json(this.view(state, body.playerId));
    }
    if (url.pathname === "/websocket") return this.connectPlayerSocket(request, state);
    if (request.method === "POST") {
      const body = await request.json() as { playerId?: string; action?: { type: string; cardId?: string; color?: Color; targetId?: string } };
      const player = state.players.find((p) => p.id === body.playerId);
      if (!player) return OTHER("You are not in this party.", 403);
      try {
        switch (url.pathname) {
          case "/start": this.start(state, player.id); break;
          case "/leave": this.leave(state, player.id); break;
          case "/rematch": this.rematch(state, player.id); break;
          case "/action": this.act(state, player.id, body.action); break;
          default: return OTHER("Not found.", 404);
        }
      } catch (error) { return OTHER(error instanceof Error ? error.message : "That move could not be made."); }
      await this.write(state);
      this.broadcast(state);
      return Response.json(this.view(state, player.id));
    }
    return OTHER("Not found.", 404);
  }

  private async connectPlayerSocket(request: Request, state: RoomState) {
    if (request.headers.get("Upgrade") !== "websocket") return OTHER("Expected a WebSocket connection.", 426);
    const playerId = new URL(request.url).searchParams.get("playerId") ?? "";
    const player = state.players.find((entry) => entry.id === playerId);
    if (!player) return OTHER("You are not in this party.", 403);
    player.connected = true; delete player.disconnectedAt;
    this.resolveUnstackablePenalty(state);
    await this.write(state);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId });
    this.broadcast(state);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    return this.serial(() => this.handleWebSocketMessage(ws, message));
  }

  private async handleWebSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    try {
      const attachment = ws.deserializeAttachment() as { playerId: string } | null;
      if (message === "ping") { ws.send("pong"); return; }
      const state = await this.read();
      if (!state || !attachment?.playerId) return;
      ws.send(JSON.stringify({ type: "state", state: this.view(state, attachment.playerId) }));
    } catch { /* Ignore malformed client messages. */ }
  }

  async webSocketClose(ws: WebSocket) { await this.serial(() => this.disconnect(ws)); }
  async webSocketError(ws: WebSocket) { await this.serial(() => this.disconnect(ws)); }
  private async disconnect(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as { playerId: string } | null;
    const state = await this.read();
    const player = state?.players.find((entry) => entry.id === attachment?.playerId);
    if (!state || !player) return;
    const stillOnline = this.ctx.getWebSockets().some((socket) => {
      const current = socket.deserializeAttachment() as { playerId?: string } | null;
      return current?.playerId === player.id && socket.readyState === WebSocket.OPEN;
    });
    if (!stillOnline) { player.connected = false; player.disconnectedAt = Date.now(); await this.write(state); this.broadcast(state); }
  }

  async alarm() { await this.serial(() => this.handleAlarm()); }

  private async handleAlarm() {
    const state = await this.read();
    if (!state) return;
    const cutoff = Date.now() - 60_000;
    const expired = state.players.filter((p) => !p.connected && p.disconnectedAt && p.disconnectedAt <= cutoff);
    for (const player of expired) this.removePlayer(state, player.id);
    if (expired.length) { await this.write(state); this.broadcast(state); }
    else if (state.players.some((p) => !p.connected && p.disconnectedAt)) {
      const nearest = Math.min(...state.players.filter((p) => !p.connected && p.disconnectedAt).map((p) => p.disconnectedAt! + 60_001));
      await this.ctx.storage.setAlarm(nearest);
    }
  }

  private start(state: RoomState, playerId: string) {
    if (state.hostId !== playerId) throw new Error("Only the host can start the game.");
    if (state.status !== "waiting") throw new Error("This party has already started.");
    if (state.players.length < 2) throw new Error("Invite at least one more player to start.");
    const deck = shuffle(makeDeck());
    for (const p of state.players) { p.hand = deck.splice(0, 7); p.unoCalled = true; }
    const first = deck.findIndex((card) => card.kind === "number");
    const [starter] = deck.splice(first, 1);
    const game: Game = { deck, discard: [starter], current: 0, direction: 1, color: starter.color as Color, pendingDraw: 0, challenge: null, hasDrawn: false, notices: [], status: "playing" };
    state.game = game; state.status = "playing";
  }

  private rematch(state: RoomState, playerId: string) {
    if (state.status !== "finished") throw new Error("The current game is still being played.");
    if (state.hostId !== playerId) throw new Error("Only the host can start a rematch.");
    for (const p of state.players) { p.hand = []; p.unoCalled = true; }
    delete state.game; state.status = "waiting";
  }

  private leave(state: RoomState, playerId: string) {
    this.removePlayer(state, playerId);
    if (state.players.length === 0) state.status = "finished";
  }

  private removePlayer(state: RoomState, playerId: string) {
    const index = state.players.findIndex((p) => p.id === playerId);
    if (index < 0) return;
    const game = state.game;
    state.players.splice(index, 1);
    if (!state.players.length) { state.status = "finished"; if (game) game.status = "finished"; return; }
    if (state.hostId === playerId) state.hostId = state.players[0].id;
    if (game) {
      if (state.players.length < 2) { game.status = "finished"; state.status = "finished"; return; }
      if (index < game.current) game.current--;
      else if (index === game.current) game.current = wrap(game.current, state.players.length);
      game.hasDrawn = false; delete game.drawnCardId;
      if (game.challenge?.offenderId === playerId || game.challenge?.challengerId === playerId) { game.challenge = null; game.pendingDraw = 0; }
    }
  }

  private act(state: RoomState, playerId: string, action?: { type: string; cardId?: string; color?: Color; targetId?: string }) {
    const game = state.game;
    if (!game || game.status !== "playing") throw new Error("The game has not started.");
    const playerIndex = state.players.findIndex((p) => p.id === playerId);
    const player = state.players[playerIndex];
    const current = state.players[game.current];
    if (!action) throw new Error("Choose a move.");
    game.notices = [];

    if (action.type === "callUno") {
      if (player.hand.length !== 1) throw new Error("You can call UNO when you have one card.");
      if (game.unoWindowPlayerId !== playerId) throw new Error("Call UNO right after playing down to one card.");
      player.unoCalled = true;
      delete game.unoWindowPlayerId;
      return;
    }
    if (action.type === "catchUno") {
      const target = state.players.find((entry) => entry.id === action.targetId);
      if (!target || target.hand.length !== 1 || target.unoCalled || game.unoWindowPlayerId !== target.id || playerId === target.id || playerIndex !== game.current) throw new Error("There is no UNO call to catch right now.");
      this.drawCards(state, target, 2);
      target.unoCalled = true;
      game.notices.push({ id: crypto.randomUUID(), playerId: target.id, count: 2, reason: "uno" });
      delete game.unoWindowPlayerId;
      return;
    }
    if (playerId !== current.id) throw new Error("It is not your turn.");

    if (game.unoWindowPlayerId) {
      const forgotten = state.players.find((entry) => entry.id === game.unoWindowPlayerId);
      if (forgotten && !forgotten.unoCalled && forgotten.hand.length === 1) {
        this.drawCards(state, forgotten, 2);
        game.notices.push({ id: crypto.randomUUID(), playerId: forgotten.id, count: 2, reason: "uno" });
        forgotten.unoCalled = true;
      }
      delete game.unoWindowPlayerId;
    }

    if (action.type === "challenge") {
      const challenge = game.challenge;
      if (!challenge || challenge.challengerId !== playerId) throw new Error("There is no Wild Draw Four to challenge.");
      const offender = state.players.find((p) => p.id === challenge.offenderId)!;
      const guilty = offender.hand.some((card) => card.color === challenge.colorBefore);
      if (guilty) {
        this.drawCards(state, offender, 4);
        game.notices.push({ id: crypto.randomUUID(), playerId: challenge.challengerId, otherPlayerId: offender.id, count: 4, reason: "challengeSuccess" });
        game.pendingDraw = 0; game.challenge = null; game.hasDrawn = false; delete game.drawnCardId;
      } else {
        this.drawCards(state, player, 6);
        game.notices.push({ id: crypto.randomUUID(), playerId: player.id, otherPlayerId: offender.id, count: 6, reason: "challengeFailed" });
        game.pendingDraw = 0; game.challenge = null; game.current = nextIndex(game, state.players.length); game.hasDrawn = false; delete game.drawnCardId;
      }
      return;
    }
    if (action.type === "draw") {
      if (game.pendingDraw > 0) {
        if (game.challenge) game.challenge = null;
        const penalty = game.pendingDraw;
        this.drawCards(state, player, penalty);
        game.notices.push({ id: crypto.randomUUID(), playerId: player.id, count: penalty, reason: "penalty" });
        game.pendingDraw = 0; game.current = nextIndex(game, state.players.length); game.hasDrawn = false; delete game.drawnCardId;
        return;
      }
      if (game.hasDrawn) throw new Error("You already drew a card this turn.");
      if (!game.deck.length) this.recycle(game);
      const card = game.deck.pop();
      if (!card) throw new Error("There are no cards left to draw.");
      player.hand.push(card); game.hasDrawn = true; game.drawnCardId = card.id;
      game.notices.push({ id: crypto.randomUUID(), playerId: player.id, count: 1, reason: "draw" });
      return;
    }
    if (action.type === "pass") {
      if (!game.hasDrawn) throw new Error("Draw a card before passing.");
      game.current = nextIndex(game, state.players.length); game.hasDrawn = false; delete game.drawnCardId;
      return;
    }
    if (action.type !== "play" || !action.cardId) throw new Error("That move is not available.");
    const cardIndex = player.hand.findIndex((card) => card.id === action.cardId);
    if (cardIndex < 0) throw new Error("That card is not in your hand.");
    const card = player.hand[cardIndex];
    if (game.hasDrawn && card.id !== game.drawnCardId) throw new Error("After drawing, you may only play the card you just drew.");
    if (!playable(card, game)) throw new Error("That card does not match the top card.");
    if ((card.kind === "wild" || card.kind === "draw4") && !COLORS.includes(action.color as Color)) throw new Error("Choose a color for your wild card.");

    const wasPenalty = game.pendingDraw > 0;
    const oldColor = game.color;
    player.hand.splice(cardIndex, 1);
    game.discard.push(card);
    game.hasDrawn = false; delete game.drawnCardId;
    if (!player.hand.length) {
      game.status = "finished"; game.winnerId = player.id; state.status = "finished";
      return;
    }
    player.unoCalled = player.hand.length !== 1;
    if (player.hand.length === 1) game.unoWindowPlayerId = player.id;
    if (card.color === "wild") game.color = action.color as Color;
    else game.color = card.color;

    if (card.kind === "draw2" || card.kind === "draw4") {
      game.pendingDraw += card.kind === "draw2" ? 2 : 4;
      const offenderNext = nextIndex(game, state.players.length);
      if (card.kind === "draw4" && !wasPenalty) game.challenge = { offenderId: player.id, challengerId: state.players[offenderNext].id, colorBefore: oldColor };
      else if (wasPenalty) game.challenge = null;
      game.current = offenderNext;
      this.resolveUnstackablePenalty(state);
      return;
    }
    game.pendingDraw = 0; game.challenge = null;
    if (card.kind === "skip") game.current = nextIndex(game, state.players.length, 2);
    else if (card.kind === "reverse") {
      game.direction = game.direction === 1 ? -1 : 1;
      game.current = nextIndex(game, state.players.length, state.players.length === 2 ? 2 : 1);
    } else game.current = nextIndex(game, state.players.length);
  }

  private drawCards(state: RoomState, player: Player, count: number) {
    const game = state.game!;
    for (let n = 0; n < count; n++) {
      if (!game.deck.length) this.recycle(game);
      const card = game.deck.pop();
      if (card) player.hand.push(card);
    }
  }

  private resolveUnstackablePenalty(state: RoomState): boolean {
    const game = state.game;
    if (!game || game.status !== "playing" || game.pendingDraw <= 0) return false;
    const player = state.players[game.current];
    if (!player || player.hand.some((card) => card.kind === "draw2" || card.kind === "draw4")) return false;

    const penalty = game.pendingDraw;
    this.drawCards(state, player, penalty);
    game.notices.push({ id: crypto.randomUUID(), playerId: player.id, count: penalty, reason: "autoPenalty" });
    game.pendingDraw = 0;
    game.challenge = null;
    game.current = nextIndex(game, state.players.length);
    game.hasDrawn = false;
    delete game.drawnCardId;
    return true;
  }

  private recycle(game: Game) {
    if (game.discard.length <= 1) return;
    const top = game.discard.pop()!;
    game.deck = shuffle(game.discard);
    game.discard = [top];
  }

  private view(state: RoomState, playerId: string) {
    const game = state.game;
    return {
      id: state.id, code: state.code, name: state.name, visibility: state.visibility, status: state.status,
      hostId: state.hostId, you: playerId,
      players: state.players.map((player, index) => ({ id: player.id, name: player.name, cardCount: player.hand.length, hand: player.id === playerId ? player.hand : undefined, connected: player.connected, unoCalled: player.unoCalled, isCurrent: !!game && game.current === index })),
      game: game ? {
        status: game.status, discard: game.discard.at(-1), currentColor: game.color, direction: game.direction, pendingDraw: game.pendingDraw,
        challengeAvailable: game.challenge?.challengerId === playerId, hasDrawn: game.current === state.players.findIndex((p) => p.id === playerId) && game.hasDrawn,
        drawnCardId: game.drawnCardId, winnerId: game.winnerId, deckCount: game.deck.length,
        notices: (game.notices ?? []).map((notice) => {
          const playerName = state.players.find((player) => player.id === notice.playerId)?.name ?? "A player";
          if (notice.reason === "uno") return { id: notice.id, text: notice.playerId === playerId ? "You missed UNO! +2 cards added to your hand." : `${playerName} forgot UNO and picked up +2.` };
          if (notice.reason === "autoPenalty") return { id: notice.id, text: notice.playerId === playerId ? `No +2 or +4 to stack — +${notice.count} cards added automatically. Your turn is skipped.` : `${playerName} had no +2 or +4 to stack and drew +${notice.count}.` };
          if (notice.reason === "penalty") return { id: notice.id, text: notice.playerId === playerId ? `+${notice.count} for you! ${notice.count} cards added to your hand.` : `${playerName} picked up +${notice.count} cards.` };
          if (notice.reason === "challengeSuccess") {
            const offenderName = state.players.find((player) => player.id === notice.otherPlayerId)?.name ?? "The player";
            return { id: notice.id, text: notice.playerId === playerId ? `Challenge successful! ${offenderName} takes +4; your turn continues.` : notice.otherPlayerId === playerId ? `Your +4 was illegal. Draw 4 cards; ${playerName} keeps their turn.` : `${offenderName} drew 4 after ${playerName} caught an illegal +4.` };
          }
          if (notice.reason === "challengeFailed") {
            const offenderName = state.players.find((player) => player.id === notice.otherPlayerId)?.name ?? "The player";
            return { id: notice.id, text: notice.playerId === playerId ? `Challenge failed — the +4 was legal. You drew 6 cards and lost your turn.` : `${playerName}'s challenge failed; ${offenderName}'s +4 was legal.` };
          }
          return { id: notice.id, text: notice.playerId === playerId ? "You drew a card." : `${playerName} drew a card.` };
        }),
      } : undefined,
    };
  }

  private listing(state: RoomState) {
    return { id: state.id, code: state.code, name: state.name, hostName: state.players.find((p) => p.id === state.hostId)?.name ?? "Host", players: state.players.length, maxPlayers: 4, visibility: state.visibility, status: state.status };
  }

  private async updateDirectory(state: RoomState) {
    await this.env.DIRECTORY.getByName("public-lobby").fetch("https://directory/update", { method: "POST", body: JSON.stringify(this.listing(state)) });
  }

  private broadcast(state: RoomState) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = socket.deserializeAttachment() as { playerId?: string } | null;
      if (!attachment?.playerId || !state.players.some((p) => p.id === attachment.playerId)) continue;
      socket.send(JSON.stringify({ type: "state", state: this.view(state, attachment.playerId) }));
    }
  }
}
