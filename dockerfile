# Use Node 20 Bullseye (Full)
FROM node:20-bullseye

# Install ONLY poppler-utils
# We removed ghostscript and graphicsmagick as they are no longer needed
RUN apt-get update && apt-get install -y \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]