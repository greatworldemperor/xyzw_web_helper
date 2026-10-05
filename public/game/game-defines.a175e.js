'use strict'
const gt =
  typeof globalThis === 'object' ? globalThis : typeof window === 'object' ? window : global
gt.PLATFORM = 'h5web'
gt.SUB_PLATFORM = ''
gt.ENV = 'Prod'
gt.APPID = 'wx0840558555a454ed'
gt.APPID = ''
gt.CDN = 'https://xxz-xyzw-res.hortorgames.com'
gt.SERVER = 'https://xxz-xyzw.hortorgames.com'
gt.GAME_NAME = '咸鱼之王'
gt.GAME_ID = 'xyzw_mix'
// 🔴 10-05 版本升级：官方 /h5web/ 现行构建（game-defines.1653c.js）实抓为
//    GAME_VERSION='1.90.3-h5web' / CODE_VERSION='1.90.3'（GAME_ID 已改名 xyzwdouyinh5，
//    此处保留已知可登录的 xyzw_mix 以最小化变量）。首帧将自然上报 h5/1.90.3-h5web。
//    每周校准：curl https://xxz-xyzw-res.hortorgames.com/h5web/ → 读 game-defines.<hash>.js。
gt.GAME_VERSION = '1.90.3-h5web'
gt.CODE_VERSION = '1.90.3'
gt.COMMIT_ID = ''
gt.CONFIG_COMMIT_ID = ''
gt.RESOURCES_COMMIT_ID = ''
gt.DOWNLOAD_URL = ''
gt.CDNS = ['https://xxz-xyzw-res.hortorgames.com', 'https://xxz-xyzw-alires.hortorgames.com']
gt.VERSION_POSTFIX = ''
gt.BATTLE_OSS_URL = 'https://xxz-xyzw-service-battle.hortorgames.com'
