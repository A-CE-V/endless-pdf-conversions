# Use Node 20 Bullseye (Full)
FROM node:20-bullseye

# Install ONLY poppler-utils
RUN apt-get update && apt-get install -y \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. COPY *ALL* PACKAGE FILES FIRST
# This includes package.json AND the essential package-lock.json
COPY package*.json ./

# 2. INSTALL DEPENDENCIES
RUN npm ci --only=production

# 3. COPY THE REST OF THE APPLICATION
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]