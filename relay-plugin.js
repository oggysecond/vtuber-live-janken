const rooms = new Map();

function getRoom(name) {
  const key = String(name || "").trim().toUpperCase();
  if (!rooms.has(key)) rooms.set(key, new Set());
  return rooms.get(key);
}

function broadcast(room, payload, except) {
  const clients = getRoom(room);
  for (const res of clients) {
    if (res === except) continue;
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function attach(middlewares) {
  middlewares.use(async (req, res, next) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/api/sub") {
      const room = url.searchParams.get("room") || "";
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("retry: 1500\n\n");
      const clients = getRoom(room);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (url.pathname === "/api/pub") {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end("method not allowed");
        return;
      }
      const room = url.searchParams.get("room") || "";
      const body = await readBody(req);
      broadcast(room, body);
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      res.end();
      return;
    }

    next();
  });
}

export function jankenRelay() {
  return {
    name: "janken-relay",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
