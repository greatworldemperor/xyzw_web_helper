<template>
  <div class="game-player">
    <button class="back-btn" @click="goBack">← 返回</button>
    <div class="src-toggle">
      <button
        :class="{ active: gameSource === 'mirror' }"
        title="本地镜像 /game/index.html（版本跟随每周校准）"
        @click="setSource('mirror')"
      >镜像</button>
      <button
        :class="{ active: gameSource === 'proxy' }"
        title="官方 h5web 实时反代 /h5web-proxy/（永远最新版，注入同一套桥）"
        @click="setSource('proxy')"
      >官方反代</button>
    </div>

    <div class="iframe-wrapper">
      <iframe
        :key="gameSrc"
        :src="gameSrc"
        class="game-iframe"
        allow="fullscreen; autoplay"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

const SOURCE_KEY = 'gameplayer:source'
const gameSource = ref(localStorage.getItem(SOURCE_KEY) === 'proxy' ? 'proxy' : 'mirror')
const gameSrc = computed(() =>
  gameSource.value === 'proxy'
    ? import.meta.env.BASE_URL + 'h5web-proxy/index.html'
    : import.meta.env.BASE_URL + 'game/index.html',
)

function setSource(v) {
  gameSource.value = v
  localStorage.setItem(SOURCE_KEY, v)
}

function goBack() {
  router.push('/admin/dashboard')
}
</script>

<style scoped>
.game-player {
  position: fixed;
  inset: 0;
  z-index: 1;
  background: #000;
}

.iframe-wrapper {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
}

.game-iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

.back-btn {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 200;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
}

.back-btn:hover {
  background: rgba(0, 0, 0, 0.7);
}

.back-btn:active {
  background: rgba(0, 0, 0, 0.8);
}

.src-toggle {
  position: absolute;
  top: 8px;
  left: 90px;
  z-index: 200;
  display: flex;
  gap: 4px;
}

.src-toggle button {
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.25);
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.2s;
}

.src-toggle button.active {
  background: rgba(64, 158, 255, 0.85);
  border-color: rgba(64, 158, 255, 0.9);
}
</style>
