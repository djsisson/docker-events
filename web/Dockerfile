# Use the official Deno image from Docker Hub
FROM denoland/deno:alpine

# Set the working directory
WORKDIR /app

# Copy the Deno script to the working directory
COPY . .

# Expose the ports for the HTTP and WebSocket servers
EXPOSE 8000

# Command to run the Deno script
CMD ["run", "-A", "main.ts"]
