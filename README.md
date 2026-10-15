# Klatts Avatar

A small web app: an **express** server hosts a **three.js** avatar that reacts
to keyboard/game input through the `klattsch` input library. Serves a live 3-D
character you can drive from the browser.

## Run
```sh
npm install
node server.js         # or: ./start.sh
```
Then open the served URL (see `start.sh` / `server.js` for the port).

## Layout
- `server.js` — express server
- `public/` — `index.html`, `app.js` (three.js scene), `style.css`

## License
MIT
