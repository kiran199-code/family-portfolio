# Builds the React frontend, then runs the API (which also serves the built frontend).
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
COPY seed/ /app/seed/
COPY --from=web /web/dist /app/frontend/dist
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npx","tsx","src/server.ts"]
