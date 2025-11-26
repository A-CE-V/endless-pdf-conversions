# Use Node 20 Bullseye (Full)
FROM node:20-bullseye

# Install Poppler binary dependencies
RUN apt-get update && apt-get install -y \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. COPY ESSENTIAL FILES
# Ensure both the package manifest and the locked dependency file are copied
COPY package.json ./
COPY package-lock.json ./ 

# 2. INSTALL DEPENDENCIES
# The change in package-lock.json will force this layer to rebuild, 
# ensuring pdf-poppler is correctly installed into node_modules.
RUN npm ci --only=production

# 3. COPY THE REST OF THE APPLICATION
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]