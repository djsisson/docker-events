const websocketUrl = Deno.env.get("WEBSOCKET_URL") || "ws://localhost:9000";

// HTML content to serve
const html = `
<!DOCTYPE html>
<html>
  <body>
    <h1>Docker Events</h1>
    <ul id="events" style="list-style: none; padding: 0; margin: 0;"></ul>
    <script>
      const ws = new WebSocket("${websocketUrl}");
      ws.onmessage = function(event) {
        const li = document.createElement("li");
        li.textContent = event.data;
        li.style.marginBottom = "10px";
        document.getElementById("events").appendChild(li);
      };
    </script>
  </body>
</html>
`;

// Function to handle WebSocket connections and stream Docker events
async function handleWebSocket(ws: WebSocket) {
  const dockerSocketPath = "/var/run/docker.sock";

  // Connect to the Docker Unix socket
  const conn = await Deno.connect({
    path: dockerSocketPath,
    transport: "unix",
  });

  // Send the HTTP request to the Docker events API
  const request = new TextEncoder().encode(
    "GET /events HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "Accept: application/json\r\n" +
      "\r\n"
  );
  await conn.write(request);

  const decoder = new TextDecoder();
  const buffer = new Uint8Array(1024);
  let leftover = "";

  while (true) {
    const n = await conn.read(buffer);
    if (n === null) break;

    const chunk = decoder.decode(buffer.subarray(0, n));
    const lines = (leftover + chunk).split("\n");

    leftover = lines.pop() || "";

    for (const line of lines) {
      if (line.trim().length === 0 || !isNaN(Number(line))) {
        continue;
      }

      try {
        const event = JSON.parse(line);
        ws.send(JSON.stringify(event));
      } catch (_error) {
        //console.error("Failed to parse event:", error, line);
      }
    }
  }
}

// Serve the HTML page on port 8000
Deno.serve({ port: 8000 }, (req) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/") {
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  } else {
    return new Response("Not Found", { status: 404 });
  }
});

console.log("HTTP server running on http://localhost:8000");

// Serve the WebSocket connection on port 9000
Deno.serve({ port: 9000 }, (req) => {
  const { response, socket } = Deno.upgradeWebSocket(req);
  handleWebSocket(socket);
  return response;
});

console.log("WebSocket server running on ws://localhost:9000");
