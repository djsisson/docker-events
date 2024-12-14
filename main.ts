const websocketUrl = Deno.env.get("WEBSOCKET_URL") || "ws://localhost:9000";

// HTML content to serve
const html = `
<!DOCTYPE html>
<html>
  <body>
    <h1>Docker Events</h1>
    <select id="container-select" style="margin-bottom: 10px;" onchange="clearEvents()"></select>
    <ul id="events" style="list-style: none; padding: 0; margin: 0;">
      <!-- events will be added here -->
    </ul>
    <script>
      const ws = new WebSocket("${websocketUrl}");
      const containerSelect = document.getElementById("container-select");
      const eventsList = document.getElementById("events");

      // Get the list of containers from the Docker API
      fetch("/containers")
        .then(response => response.json())
        .then(containers => {
          containers.forEach(container => {
            const option = document.createElement("option");
            option.value = container.Id;
            option.textContent = container.Names[0].slice(1);
            containerSelect.appendChild(option);
          });
        });

      ws.onmessage = function(event) {
        const eventData = JSON.parse(event.data);
        const selectedContainerId = containerSelect.value;
        if (eventData.Actor.ID === selectedContainerId) {
          const li = document.createElement("li");
          li.textContent = event.data;
          li.style.marginBottom = "10px";
          eventsList.appendChild(li);
        }
      };

      function clearEvents() {
        eventsList.innerHTML = "";
      }
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

// Function to get the list of containers from the Docker API
async function getContainers() {
  const dockerSocketPath = "/var/run/docker.sock";
  const conn = await Deno.connect({
    path: dockerSocketPath,
    transport: "unix",
  });
  const request = new TextEncoder().encode(
    "GET /containers/json?all=true HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "Accept: application/json\r\n" +
      "\r\n"
  );
  await conn.write(request);
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(1024);
  let chunks = "";
  while (true) {
    const n = await conn.read(buffer);
    if (n === null || n === 0) break;
    let chunk = decoder.decode(buffer.subarray(0, n));
    // Skip headers
    if (chunk.startsWith("HTTP/1.1")) continue;
    // Skip chunk length indicator and newline character
    const match = chunk.match(/^([0-9a-fA-F]+)\r\n/);
    if (match) {
      chunk = chunk.slice(match[0].length);
    }
    chunks += chunk;
    if (chunks.endsWith("\r\n")) {
      break;
    }
  }
  conn.close();
  return JSON.parse(chunks);
}

// Serve the HTML page on port 8000
Deno.serve({ port: 8000 }, async (req) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/") {
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  } else if (pathname === "/containers") {
    return new Response(JSON.stringify(await getContainers()), {
      headers: { "Content-Type": "application/json" },
    });
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
