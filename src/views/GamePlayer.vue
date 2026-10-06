<template>
  <div class="game-player">
    <button class="back-btn" @click="goBack">← 返回</button>

    <div class="iframe-wrapper">
      <iframe
        :src="gameSrc"
        class="game-iframe"
        allow="fullscreen; autoplay"
      />
    </div>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router'

const router = useRouter()

// runtime 宿主 = 本地镜像（/game/index.html）：bridge/token 注入 + spoof 默认上报活通道现行串。
// 官方 /h5web/ 实时反代已于 2026-10-06 park（死通道本体，迁移死端=设计行为，详见 KB 02-toolchain §7.6）。
const gameSrc = import.meta.env.BASE_URL + 'game/index.html'

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
</style>
