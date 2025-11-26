# Use a lightweight Node image
FROM node:20-bullseye-slim

# Install system dependencies required for image processing and native module compilation
RUN apt-get update && apt-get install -y \
    # Core PDF/Image tools
    graphicsmagick \
    ghostscript \
    poppler-utils \
    # Development libraries for graphics (sharp/native modules)
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm ci --only=production

# Copy the rest of the app
COPY . .

# Expose the port
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]