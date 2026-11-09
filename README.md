# Lovely Kumari Art

A small, dependency-free Node.js website for custom artwork orders. It serves the site, saves enquiries locally, exposes an admin orders API, and includes optional Instagram Graph API and Razorpay Checkout integrations.

## Run in VS Code

1. Open this folder in VS Code.
2. Copy `.env.example` to `.env` and set a long random `ADMIN_API_KEY`.
3. In the VS Code terminal, run `npm start` (Node.js 20 or newer).
4. Open `http://localhost:3000`.

Orders are stored in `data/orders.json`, which is ignored by Git. The reference photo (if supplied) is stored with its order, so keep the data folder private and back it up. For a public deployment, replace the JSON file store with a managed database and private object storage.

## API routes

- `GET /api/health` — server status.
- `POST /api/orders` — validate and save an artwork enquiry.
- `GET /api/orders` — list enquiries. Requires `Authorization: Bearer <ADMIN_API_KEY>`.
- `GET /api/instagram/feed` — returns recent Instagram media when Instagram API settings are present; otherwise returns an unconfigured response.
- `POST /api/payments/create-order` — creates a Razorpay order for the server-calculated estimate.
- `POST /api/payments/verify` — verifies Razorpay's checkout signature and records the payment reference.

## Connect integrations

- **Instagram:** Set the professional account username, user ID and access token in `.env`. The site reads recent media through Meta's Graph API. The token stays on the server.
- **Razorpay:** Set test mode key ID and key secret in `.env` first. Switch to live credentials only after the merchant account is enabled and a test payment succeeds. The secret must never go in browser code.
- **WhatsApp:** Set `ARTIST_WHATSAPP` in `.env` using digits with country code, for example `919876543210`.

Estimates are starter values and are calculated again on the server. Review the price list in `server.js` before taking customer orders. A valid Razorpay checkout signature confirms the callback data; check payment capture status in the Razorpay dashboard before fulfilling an order.

## GitHub and VS Code

This folder is ready to open in VS Code and initialize as a Git repository. Never commit `.env` or `data/orders.json`. Choose the intended GitHub repository before setting its remote or pushing.

