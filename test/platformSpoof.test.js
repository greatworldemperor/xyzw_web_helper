import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../public/game/platform-spoof.js", import.meta.url),
  "utf8",
);

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  getItem(key) {
    return this.values.has(String(key)) ? this.values.get(String(key)) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }
}

function execute(pathname, entries) {
  const localStorage = new MemoryStorage(entries);
  const window = {
    PLATFORM: "h5web",
    GAME_VERSION: "1.89.8-wx",
    localStorage,
    location: { pathname },
  };
  const console = {
    log() {},
    warn() {},
  };

  vm.runInNewContext(source, { console, localStorage, window });
  return { localStorage, window };
}

test("batch runtime reads its own spoof key and ignores research config", () => {
  const result = execute("/helper/game/multi-game.html", [
    [
      "xyzwMultiGamePlatformSpoof",
      JSON.stringify({ enabled: true, platform: "h5", gameVersion: "" }),
    ],
    [
      "xyzwPlatformSpoof",
      JSON.stringify({ enabled: true, platform: "mix", gameVersion: "" }),
    ],
  ]);

  assert.equal(
    result.window.__xyzwPlatformSpoof.KEY,
    "xyzwMultiGamePlatformSpoof",
  );
  assert.equal(result.window.PLATFORM, "h5");
  assert.equal(result.window.__xyzwPlatformSpoof.applied.active, true);
});

test("ordinary runtime keeps the research spoof key independent", () => {
  const result = execute("/helper/game/index.html", [
    [
      "xyzwMultiGamePlatformSpoof",
      JSON.stringify({ enabled: true, platform: "h5", gameVersion: "" }),
    ],
    [
      "xyzwPlatformSpoof",
      JSON.stringify({ enabled: true, platform: "mix", gameVersion: "" }),
    ],
  ]);

  assert.equal(result.window.__xyzwPlatformSpoof.KEY, "xyzwPlatformSpoof");
  assert.equal(result.window.PLATFORM, "mix");
  assert.equal(result.window.__xyzwPlatformSpoof.applied.active, true);
});