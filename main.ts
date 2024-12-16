const indexHtml = await Deno.readTextFile("./index.html");
const statsHtml = await Deno.readTextFile("./stats.html");

// Function to handle WebSocket connections and stream Docker events
async function containerEvents(ws: WebSocket, abortSignal: AbortSignal) {
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

  while (!abortSignal.aborted) {
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

async function readResponse(conn: Deno.Conn) {
  const chunks = [];
  let headers = false;
  let isChunked = true;
  while (isChunked) {
    const buffer = new Uint8Array(1024 * 1024); // 1MB buffer
    const n = await conn.read(buffer);
    if (n === null || n === 5) break;
    const chunk = buffer.subarray(0, n);
    if (!headers) {
      const headerLines = new TextDecoder()
        .decode(chunk)
        .split("\r\n\r\n", 2)[0]
        .split("\n");
      headerLines.forEach((line) => {
        if (line.startsWith("Transfer-Encoding:")) {
          isChunked = line.split(" ")[1] === "chunked";
        } else if (line.startsWith("Content-Length:")) {
          const contentLength = Number(line.split(" ")[1]);
          if (contentLength > 0) {
            isChunked = false;
          }
        }
      });
      headers = true;
    }
    const lastFiveBytes = chunk.slice(-5);
    chunks.push(chunk);
    if (
      lastFiveBytes.every((byte, index) => byte === [48, 13, 10, 13, 10][index])
    ) {
      break;
    }
  }
  const decoder = new TextDecoder();
  const concatenatedChunks = new Uint8Array(
    chunks.reduce((acc, chunk) => acc + chunk.length, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    concatenatedChunks.set(chunk, offset);
    offset += chunk.length;
  }
  const text = decoder.decode(concatenatedChunks);
  const data = text.split("\r\n\r\n", 2);
  if (data.length === 2) {
    const _headers = data[0];
    let body = data[1];
    let concatenatedBody = "";
    if (isChunked) {
      while (body.length > 0) {
        const frame = body.split("\r\n", 2);
        const frameContents = frame[1].slice(0, parseInt(`0x${frame[0]}`, 16));
        concatenatedBody += frameContents;
        body = frame[1].slice(frameContents.length);
      }
    } else {
      concatenatedBody = body;
    }
    // process headers and body

    return concatenatedBody;
  } else {
    // handle the case where \r\n\r\n is not found
    return text;
  }
}

// Function to get the list of containers from the Docker API
async function getContainers(all: boolean) {
  const dockerSocketPath = "/var/run/docker.sock";
  const conn = await Deno.connect({
    path: dockerSocketPath,
    transport: "unix",
  });
  const request = new TextEncoder().encode(
    `GET /containers/json?all=${all} HTTP/1.1\r\n` +
      "Host: localhost\r\n" +
      "Accept: application/json\r\n" +
      "\r\n"
  );
  await conn.write(request);
  const response = await readResponse(conn);
  try {
    const data = JSON.parse(response);
    return data.map((container: { Id: string; Names: string[] }) => ({
      Id: container.Id,
      Names: container.Names,
    }));
  } catch (_error) {
    console.log(_error);
    return [];
  }
}

async function getContainerStats(containerId: string) {
  const dockerSocketPath = "/var/run/docker.sock";
  const conn = await Deno.connect({
    path: dockerSocketPath,
    transport: "unix",
  });

  const statsRequest = new TextEncoder().encode(
    `GET /containers/${containerId}/stats?stream=false HTTP/1.1\r\n` +
      "Host: localhost\r\n" +
      "Accept: application/json\r\n" +
      "\r\n"
  );
  await conn.write(statsRequest);
  const response = await readResponse(conn);
  return response;
}

async function getContainersWithStats() {
  const containers = await getContainers(false);
  const containersWithStats = await Promise.all(
    containers.map(async (container: { Id: string }) => {
      const stats = await getContainerStats(container.Id);
      return formatStats(stats);
    })
  );
  return containersWithStats;
}

function formatStats(stats: string) {
  const {
    id,
    cpu_stats,
    memory_stats,
    networks,
    pids_stats,
    name,
    precpu_stats,
    _blkio_stats,
  } = JSON.parse(stats);
  interface Network {
    rx_bytes: number;
    tx_bytes: number;
  }
  const used_memory = memory_stats.usage;
  const available_memory = memory_stats.limit;
  const memory_usage = (used_memory / available_memory) * 100.0;
  const cpu_delta =
    cpu_stats.cpu_usage.total_usage - precpu_stats.cpu_usage.total_usage;
  const system_cpu_delta =
    cpu_stats.system_cpu_usage - precpu_stats.system_cpu_usage;
  const number_cpus =
    cpu_stats.cpu_usage?.percpu_usage?.length || cpu_stats.online_cpus;
  const CPU_usage = (cpu_delta / system_cpu_delta) * number_cpus * 100.0;
  const networkRead =  (networks) ? (Object.values(networks) as Network[]).reduce(
    (acc, network: Network) => acc + network.rx_bytes,
    0
  ): 0;
  const networkWrite = (networks) ? (Object.values(networks) as Network[]).reduce(
    (acc, network: Network) => acc + network.tx_bytes,
    0
  ): 0;

  return {
    ContainerID: id.slice(0, 12),
    Name: name.slice(1),
    CPUUsage: CPU_usage.toFixed(2),
    MemoryUsage: memory_usage.toFixed(2),
    Pids: pids_stats.current,
    used_memory: formatBytes(memory_stats.usage),
    available_memory: formatBytes(available_memory),
    cpu_delta,
    system_cpu_delta,
    number_cpus,
    networkRead: formatBytes(networkRead),
    networkWrite: formatBytes(networkWrite),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(2)} KiB`;
  } else if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  } else {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  }
}

// Serve the HTML page on port 8000
Deno.serve({ port: 8000 }, async (req) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/") {
    return new Response(indexHtml, {
      headers: { "Content-Type": "text/html" },
    });
  } else if (pathname === "/containers") {
    return new Response(JSON.stringify(await getContainers(true)), {
      headers: { "Content-Type": "application/json" },
    });
  } else if (pathname === "/containerstats") {
    return new Response(JSON.stringify(await getContainersWithStats()), {
      headers: { "Content-Type": "application/json" },
    });
  } else if (pathname === "/ws") {
    const { response, socket } = Deno.upgradeWebSocket(req);
    let abortController = new AbortController();
    socket.addEventListener("message", (event) => {
      abortController.abort();
      abortController = new AbortController();
      switch (event.data) {
        case "events":
          containerEvents(socket, abortController.signal);
          break;
        case "stats":
          getContainersWithStats().then((containersWithStats) => {
            socket.send(JSON.stringify(containersWithStats));
          });
          break;
      }
    });
    return response;
  } else if (pathname === "/stats") {
    return new Response(statsHtml, {
      headers: { "Content-Type": "text/html" },
    });
  } else {
    return new Response("Not Found", { status: 404 });
  }
});

console.log("HTTP server running on http://localhost:8000");
