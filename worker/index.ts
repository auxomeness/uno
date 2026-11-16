import { Directory } from "./directory";
import { GameRoom } from "./room";

export { Directory, GameRoom };

interface Env {
  DIRECTORY: DurableObjectNamespace<Directory>;
  ROOMS: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const directory = env.DIRECTORY.getByName("public-lobby");

    if (url.pathname.startsWith("/api/")) {
      try {
        if (url.pathname === "/api/rooms" && request.method === "GET") {
          return directory.fetch("https://directory/rooms");
        }
        if (url.pathname === "/api/rooms" && request.method === "POST") {
          return directory.fetch(new Request("https://directory/rooms", { method: "POST", body: await request.text() }));
        }
        if (url.pathname === "/api/join" && request.method === "POST") {
          return directory.fetch(new Request("https://directory/join", { method: "POST", body: await request.text() }));
        }
        const match = url.pathname.match(/^\/api\/rooms\/([a-f0-9-]+)(?:\/(join|state|start|action|leave|rematch))?$/i);
        if (match) {
          const [, roomId, operation = "state"] = match;
          const room = env.ROOMS.getByName(roomId);
          if (operation === "state" && request.method === "GET") {
            const playerId = url.searchParams.get("playerId") ?? "";
            return room.fetch(`https://room/state?playerId=${encodeURIComponent(playerId)}`);
          }
          if (request.method === "POST") {
            return room.fetch(new Request(`https://room/${operation}`, { method: "POST", body: await request.text() }));
          }
        }
        return json({ error: "Not found" }, 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Something went wrong";
        return json({ error: message }, 400);
      }
    }

    const wsMatch = url.pathname.match(/^\/ws\/([a-f0-9-]+)$/i);
    if (wsMatch) {
      const socketUrl = new URL("/websocket", request.url);
      socketUrl.search = url.search;
      return env.ROOMS.getByName(wsMatch[1]).fetch(new Request(socketUrl, request));
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
