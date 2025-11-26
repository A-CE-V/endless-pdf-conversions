# Use the FULL bullseye image (not slim) to ensure all shared libs are present
FROM node:20-bullseye

# Install dependencies
# 'ghostscript' and 'graphicsmagick' are the core requirements
RUN apt-get update && apt-get install -y \
    graphicsmagick \
    ghostscript \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Fix for OpenSSL/Ghostscript policy issues (common in Docker)
# This allows Ghostscript to read files it might otherwise block
RUN sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/' /etc/ImageMagick-6/policy.xml || true

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]