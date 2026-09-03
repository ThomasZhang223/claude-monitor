/** Entry point: bind the route table to 127.0.0.1 only, never the network. */
import { createServer, HOST, PORT } from "./http.ts";

createServer().listen(PORT, HOST, () => {
  console.log(`board listening on http://${HOST}:${PORT}`);
});
