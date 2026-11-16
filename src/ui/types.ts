export type Color = "red" | "yellow" | "green" | "blue";
export type Kind = "number" | "skip" | "reverse" | "draw2" | "wild" | "draw4";
export type Card = { id: string; color: Color | "wild"; kind: Kind; value?: number };
export type PlayerView = { id: string; name: string; cardCount: number; hand?: Card[]; connected: boolean; unoCalled: boolean; isCurrent: boolean };
export type GameNotice = { id: string; text: string; kind?: "unoCall" };
export type RoomView = {
  id: string; code: string; name: string; visibility: "public" | "private"; status: "waiting" | "playing" | "finished";
  hostId: string; you: string; players: PlayerView[];
  game?: { status: "playing" | "finished"; discard?: Card; currentColor: Color; direction: 1 | -1; pendingDraw: number; hasDrawn: boolean; drawnCardId?: string; winnerId?: string; deckCount: number; notices?: GameNotice[] };
};
export type RoomListing = { id: string; code: string; name: string; hostName: string; players: number; maxPlayers: number; visibility: "public" | "private"; status: "waiting" | "playing" | "finished" };
