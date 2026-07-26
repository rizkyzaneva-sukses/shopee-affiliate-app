FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src ./src

# Frontend will be mounted or copied in production image
# For single image we also copy frontend
COPY ../frontend ./frontend
COPY ../database ./database

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/index.js"]
