# E-commerce Backend (NestJS + MongoDB)

High-throughput NestJS API with MongoDB, Redis cache, JWT auth, and Socket.io realtime events.

## Stack

- NestJS + TypeScript
- MongoDB (Mongoose)
- Redis (cache, rate limit, Socket.io adapter)
- Socket.io (`/realtime` namespace)
- Docker Compose

## Quick start

### Option A — Docker (recommended)

```bash
cp .env.example .env
docker compose up --build
```

API: `http://localhost:3000/api/v1`  
Health: `http://localhost:3000/health`  
Realtime: `ws://localhost:3000/realtime`

### Option B — Local Node

1. Start MongoDB and Redis locally (or via Compose without `api`).
2. Copy env and point URIs to localhost:

```bash
cp .env.example .env
npm install
npm run start:dev
```

## Main routes (`/api/v1`)

| Area | Method | Path |
|------|--------|------|
| Auth | POST | `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` |
| Users | GET/PATCH | `/users/me`, POST `/users/me/addresses` |
| Categories | GET | `/categories`, `/categories/:slug` |
| Categories | POST/PATCH/DELETE | admin |
| Products | GET | `/products`, `/products/:slug` |
| Products | POST/PATCH/DELETE | admin |
| Cart | GET/POST/PATCH/DELETE | `/cart` (+ `x-guest-id` header for guests) |
| Orders | POST/GET | `/orders`, `/orders/mine`, `/orders/:id` |
| Orders | PATCH | `/orders/:id/status` (admin) |
| Inventory | PATCH | `/inventory/:productId` (admin) |
| Payments | POST | `/payments/webhook` |
| SEO | GET | `/seo/sitemap`, `/seo/products/:slug`, `/seo/categories/:slug` |
| Health | GET | `/health` |

## Realtime events (`/realtime`)

Client emits:

```json
{ "event": "join", "data": { "token": "<accessToken>", "rooms": ["order:ID", "product:ID"] } }
```

Server emits:

- `order.status` — order status changes
- `product.stock` — stock changes
- `cart.updated` — cart mutations
- `admin.alert` — new order / low stock

## Auth

- Access JWT + refresh JWT
- Roles: `customer`, `admin`
- Protect admin routes with Bearer token

To promote an admin in MongoDB:

```js
db.users.updateOne({ email: "you@example.com" }, { $set: { role: "admin" } })
```

## Scripts

```bash
npm run start:dev
npm run build
npm run start:prod
```
