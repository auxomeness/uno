# Shuffle Club

A multiplayer, UNO-style card party for 2–4 real players. Rooms are public or invite-only. Game state and player hands are authoritative on a Cloudflare Durable Object per room; guests connect over WebSockets.

## Run locally

```sh
npm install
npm run dev:stack
```

Open the Vite URL printed in the terminal (normally `http://localhost:5173`). `dev:stack` builds the client, starts the local Worker and Durable Objects on port 8787, and starts the Vite server with API and WebSocket proxies.

To serve the built app and Worker together, run:

```sh
npm run build
npm run dev:worker
```

## Deploy

Sign in with Wrangler first, then run `npm run deploy`. The Worker serves the static Vite build and routes the lobby and game API to Durable Objects. This repository does not include Cloudflare account credentials or a deployed site.

## Rules

- Seven cards per player; match by color, number, or symbol. Draw one if unable to play; a playable drawn card may be played immediately.
- Skip, reverse, wild, Wild Draw Four challenge, and UNO call/catch follow classic rules.
- Any +2 or +4 can stack on any pending draw penalty. If a player cannot stack, they draw the total and miss their turn.
- A +4 that starts a penalty chain can be challenged. A +4 played as a stack response is valid and cannot be challenged.
- First player out wins the round. A host can start a rematch in the same party.

Guests choose a display name; no account is needed. Guest identities are stored in local browser storage, so switching devices creates a new player identity.
