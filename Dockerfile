# Use the official Deno image from Docker Hub
FROM denoland/deno:alpine

# Set the working directory
WORKDIR /app

# Copy the Deno script to the working directory
COPY main.ts .

# Expose the ports for the HTTP and WebSocket servers
EXPOSE 8000
EXPOSE 9000

# Command to run the Deno script
CMD ["run", "--allow-net", "--allow-read=/var/run/docker.sock", "--allow-write=/var/run/docker.sock", "--allow-env", "main.ts"]
