import { DurableObject } from "cloudflare:workers";
import type { GameRoom } from "./room";

interface Env { ROOMS: DurableObjectNamespace<GameRoom>; }
export interface RoomListing {
  id: string;
  code: string;
  name: string;
  hostName: string;
  players: number;
  maxPlayers: number;
  visibility: "public" | "private";
  status: "waiting" | "playing" | "finished";
  updatedAt: number;
}

export class Directory extends DurableObject<Env> {
  private async listings(): Promise<RoomListing[]> {
    const rooms = await this.ctx.storage.list<RoomListing>({ prefix: "room:" });
    return Array.from(rooms.values());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/rooms" && request.method === "GET") {
      const rows = (await this.listings()).filter((room) => room.visibility === "public" && room.status !== "finished");
      return Response.json(rows.sort((a, b) => b.updatedAt - a.updatedAt));
    }
    if (url.pathname === "/rooms" && request.method === "POST") {
      const body = await request.json() as { name?: string; hostName?: string; playerId?: string; visibility?: "public" | "private" };
      if (!body.playerId) return Response.json({ error: "Create a guest profile first." }, { status: 400 });
      const id = crypto.randomUUID();
      let code = "";
      do { code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (n) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[n % 32]).join(""); }
      while ((await this.listings()).some((entry) => entry.code === code));
      const room = this.env.ROOMS.getByName(id);
      const result = await room.fetch("https://room/create", {
        method: "POST", body: JSON.stringify({ id, code, name: body.name, hostName: body.hostName, playerId: body.playerId, visibility: body.visibility ?? "public" }),
      });
      const payload = await result.json() as { error?: string };
      if (!result.ok) return Response.json(payload, { status: result.status });
      const listing = payload as unknown as RoomListing;
      await this.upsert(listing);
      return Response.json(listing, { status: 201 });
    }
    if (url.pathname === "/join" && request.method === "POST") {
      const body = await request.json() as { code?: string; playerId?: string; name?: string };
      const entry = (await this.listings()).find((room) => room.code === body.code?.trim().toUpperCase());
      if (!entry) return Response.json({ error: "That invite code was not found. Check it and try again." }, { status: 404 });
      return this.env.ROOMS.getByName(entry.id).fetch("https://room/join", { method: "POST", body: JSON.stringify(body) });
    }
    if (url.pathname === "/update" && request.method === "POST") {
      const listing = await request.json() as RoomListing;
      await this.upsert(listing);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/remove" && request.method === "POST") {
      const { id } = await request.json() as { id: string };
      await this.ctx.storage.delete(`room:${id}`);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async upsert(listing: RoomListing) {
    if (listing.status === "finished") await this.ctx.storage.delete(`room:${listing.id}`);
    else await this.ctx.storage.put(`room:${listing.id}`, { ...listing, updatedAt: Date.now() });
  }
}
