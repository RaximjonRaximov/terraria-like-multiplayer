# Terraria-like Multiplayer

A browser-based 2D multiplayer sandbox game inspired by Terraria. Built with Node.js, Express, Socket.IO, and HTML5 Canvas.

## Features

- Real-time multiplayer with Socket.IO
- Procedurally generated 2D world (grass, dirt, stone, trees, caves)
- Platformer physics (gravity, collision, jumping)
- Mining and building blocks
- Camera follows the player
- Works on desktop and mobile browsers

## Controls

- **Move:** A/D or Arrow Left/Right
- **Jump:** W, Arrow Up, or Space
- **Mine block:** Left click
- **Build dirt block:** Right click

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Open a second tab to see other players.

## Deploy

The server can be deployed to any Node.js host. Set the `PORT` environment variable if needed.
