# SMW Online Race

Race your friends through **Super Mario World** in the browser, start to Bowser. Everyone brings their own ROM. It loads only in their own browser and is never uploaded.

- **Fair start:** at GO, every racer's game resets at the same moment and their save RAM is wiped, so everyone starts from a fresh file.
- **Ghosts:** other racers show up as translucent ghosts with name tags whenever you're in the same room of the same level.
- **Live tracker:** shows where everyone is (title, map, level), their exits, power-up, Yoshi, lives and coins.
- **Auto finish:** the finish is detected when the ending starts (RAM `$13C6` = 8). The host also has a 🏁 button to mark someone finished by hand.
- **No cheating features:** save states, rewind, fast-forward and slow-mo are blocked during a race.

## How it works

Each racer runs the real game in [EmulatorJS](https://emulatorjs.org) with the snes9x core. The core can't read memory directly, so the client asks it for a save state, pulls the 128 KiB work-RAM block out of it, and searches the emulator's memory for that same block to find live WRAM (see `public/ram.js`). From then on it reads Mario's position, the camera, and the game mode every frame, and sends about 15 tiny packets a second to the relay server (`server.js`). The server never handles any game data.

## Run it locally

```
npm install
npm start          # http://localhost:8080
npm test           # server race-logic tests
```

## Deploy for free on Render

1. Push this folder to a GitHub repo.
2. In Render, choose **New → Blueprint** and pick the repo. `render.yaml` sets everything up.
3. Share `https://<your-app>.onrender.com/?room=ANYCODE` with friends.

Free Render services go to sleep after about 15 minutes idle. The first visit afterwards takes about a minute to wake up, then everything is snappy.

## SMW RAM addresses used

| Address | Meaning |
|---|---|
| `$0100` | game mode (`$0E` map, `$14` level) |
| `$0094` / `$0096` | Mario X / Y in the level |
| `$001A` / `$001C` | camera (layer 1) X / Y |
| `$0065`–`$0067` | layer-1 data pointer (identifies the room) |
| `$13BF` | translevel number |
| `$0019` | power-up · `$0076` facing · `$187A` riding Yoshi |
| `$0DBE` lives · `$0DBF` coins · `$1F2E` exits |
| `$13C6` | cutscene number, `8` = ending/credits (the finish line) |

## Testing without the game

`python3 test/make_test_rom.py test.sfc` builds a tiny homebrew cartridge that fakes those RAM values, which is handy for checking the pipeline. `test/race-two.js` drives two headless browsers through a full race (needs Playwright and a ROM path).

## Credits & licences

EmulatorJS (GPL-3.0) and the snes9x core (non-commercial licence) are vendored in `public/ejs/`. This is a non-commercial fan project and is not affiliated with Nintendo. No ROMs are included. Use your own legally dumped copy.
