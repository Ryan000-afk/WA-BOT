FROM node:20-slim

# Install dependencies yang dibutuhkan jika ada
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Salin package.json & install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Salin source code
COPY . .

# Buat folder session
RUN mkdir -p wa_session

# Expose port untuk health-check (Hugging Face Spaces default: 7860)
EXPOSE 7860

ENV PORT=7860
ENV NODE_ENV=production

# Jalankan bot
CMD ["npm", "run", "start:wa"]
