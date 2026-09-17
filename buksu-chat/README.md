# Buksu Chat

A lightweight real-time chat app built with Express and Socket.IO.

## Features

- Real-time messaging across connected clients
- Name-based chat identity
- Typing indicator
- Community-style chat layout
- Static front-end served by the Node server

## Run locally

1. Open a terminal in this folder.
2. Install dependencies:
   npm install
3. Start the app:
   npm start
4. Visit:
   http://localhost:3000

## Project structure

- `server.js` — Node server and Socket.IO event handling
- `public/index.html` — chat interface
- `public/app.js` — client-side chat logic
- `public/style.css` — UI styling
- `public/supabase-config.js` — placeholder config for future Supabase integration

## Health check

The app also exposes a lightweight status endpoint:

- http://localhost:3000/health
