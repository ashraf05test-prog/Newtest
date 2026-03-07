FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Latest yt-dlp with impersonation support
RUN pip3 install -U yt-dlp[default] --break-system-packages

# Install curl-cffi for TikTok impersonation
RUN pip3 install curl-cffi --break-system-packages

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p temp

EXPOSE 3000
CMD ["node", "server.js"]
