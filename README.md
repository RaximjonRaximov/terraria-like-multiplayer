# Mario-like Multiplayer

A browser-based 2D multiplayer platformer inspired by classic Mario gameplay. Built with Node.js, Express, Socket.IO, and HTML5 Canvas.

## Features

- Real-time multiplayer with Socket.IO
- Procedurally generated side-scrolling level with ground, platforms, pipes, pits
- Coins to collect, walking enemies to stomp, and a flagpole finish
- Platformer physics (gravity, collision, jumping, one-way platforms)
- Camera follows the player and only draws visible tiles for smooth performance
- Touch controls for mobile
- Scoreboard and win banner

## Controls

- **Move:** A/D or Arrow Left/Right
- **Jump:** W, Arrow Up, or Space
- **Mobile:** use the on-screen left/right/jump buttons

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Open a second tab to see other players.

## Deploy

The server can be deployed to any Node.js host. Set the `PORT` environment variable if needed.
