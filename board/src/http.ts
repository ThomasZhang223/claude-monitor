/**
 * The route table. One route today — GET /api/sessions — because this stage
 * only lays the wire types the rest of the board is built on. Auth, the
 * config route, and every other route are Stage 2's job (see the plan).
 */
import * as http from "http";
import { getSessionListing } from "./sessions.ts";

export const HOST = "127.0.0.1";
export const PORT = 7788;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

export function createServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/sessions") {
      getSessionListing()
        .then((listing) => sendJson(res, 200, listing))
        .catch((err) => sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
}
