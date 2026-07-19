FROM node:20-slim

WORKDIR /app

# Install dependencies first for better caching
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install

# Copy source and config
COPY tsconfig.json ./
COPY src ./src

# Build the project
RUN npm run build

# Copy entrypoint script
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# The .env file and cache should be mounted as volumes or provided as environment variables
# but we'll default to running via the entrypoint loop
ENTRYPOINT ["./entrypoint.sh"]
