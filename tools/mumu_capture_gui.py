#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MuMu 模拟器 tcpdump 抓包工具（xyzw 协议逆向用）—— tkinter GUI + CLI 双模式

零第三方依赖（纯标准库）。流程与 2026-10-22 实测口径一致：
  1) adb connect 127.0.0.1:<port>（MuMu 12 默认 16384）
  2) 设备端脱离会话启动 tcpdump：su -c 'nohup tcpdump -i wlan0 -s 0 -U -w <file> &'
     （🔴 不能用 host 侧后台 adb shell 挂着抓——会话断 tcpdump 就死）
  3) 停止 = su -c 'pkill -INT tcpdump'（SIGINT 正常收尾 flush，🔴 不要 -9）
  4) adb pull 拉回 local-data/captures/，可选自动抽 RFC6455 WS 帧（frames.txt）

用法：
  python mumu_capture_gui.py            # GUI
  python mumu_capture_gui.py --cli auto # 无头全链路自测：连接→抓5秒→停→拉回→抽帧
  python mumu_capture_gui.py --cli connect | start | stop | status
"""
import glob
import os
import queue
import re
import struct
import subprocess
import sys
import threading
import time
import tkinter as tk
import tkinter.filedialog as tkfiledialog
import tkinter.scrolledtext as tkscrolled
import tkinter.ttk as ttk
from datetime import datetime

# ────────────────────────────── 常量 ──────────────────────────────

DEFAULT_PORT = 16384  # MuMu 12 首实例；备选见 FALLBACK_PORTS
FALLBACK_PORTS = [16416, 7555, 5555, 21503]
ADB_CANDIDATE_GLOBS = [
    r"C:\Program Files\Netease\MuMu\nx_device\*\shell\adb.exe",
    r"C:\Program Files\Netease\MuMu\nx_main\adb.exe",
    r"C:\Program Files\Netease\MuMuPlayer-12.0\shell\adb.exe",
    r"C:\Program Files\Netease\MuMuPlayer\shell\adb.exe",
    r"C:\Program Files (x86)\Netease\MuMu\emulator\nemu\vmonitor\bin\adb_server.exe",
]
DEVICE_TCPDUMP = "/system/bin/tcpdump"
DEVICE_TMP_DIR = "/data/local/tmp"
STATE_FILE = os.path.join(
    os.environ.get("TEMP", os.path.expanduser("~")), "mumu_capture_state.json"
)
CREATE_NO_WINDOW = 0x08000000  # Windows: 不弹 adb 控制台


def now_text():
    return datetime.now().strftime("%H:%M:%S")


def repo_captures_dir():
    """默认保存目录：<仓库>/local-data/captures（脚本在 tools/ 下时）；否则 ~/Documents/xyzw_captures"""
    here = os.path.dirname(os.path.abspath(__file__))
    cand = os.path.normpath(os.path.join(here, "..", "local-data", "captures"))
    if os.path.isdir(os.path.normpath(os.path.join(here, "..", "src"))):
        return cand
    return os.path.join(os.path.expanduser("~"), "Documents", "xyzw_captures")


def find_adb():
    """找 adb.exe：PATH → MuMu 常见安装位置（取修改时间最新的）"""
    for name in ("adb", "adb.exe"):
        path = os.environ.get("PATH", "")
        for d in path.split(os.pathsep):
            p = os.path.join(d.strip('"'), name)
            if os.path.isfile(p):
                return p
    found = []
    for g in ADB_CANDIDATE_GLOBS:
        found.extend(glob.glob(g))
    if not found:
        return None
    return max(found, key=os.path.getmtime)


# ────────────────────────────── 核心类 ──────────────────────────────

class MuMuCapture:
    """adb/tcpdump 操作封装。所有方法阻塞，GUI 里放 worker 线程跑。"""

    def __init__(self, adb_path, port, logfn):
        self.adb = adb_path
        self.port = port
        self.serial = f"127.0.0.1:{port}"
        self.log = logfn or (lambda msg: print(f"[{now_text()}] {msg}"))
        self.interface = "wlan0"

    # ---- 底层 ----
    def _adb(self, args, timeout=15, root=False):
        cmd = [self.adb, "-s", self.serial] + list(args)
        if root:
            # adb shell 的参数由设备端 shell 解析，内层单引号传给 su -c
            cmd = [self.adb, "-s", self.serial, "shell", "su -c '" + args[0] + "'"]
        try:
            r = subprocess.run(
                cmd, capture_output=True, timeout=timeout,
                creationflags=CREATE_NO_WINDOW,
            )
            out = (r.stdout or b"").decode("utf-8", "replace").strip()
            err = (r.stderr or b"").decode("utf-8", "replace").strip()
            return r.returncode, out, err
        except subprocess.TimeoutExpired:
            return 124, "", f"超时（>{timeout}s）"
        except FileNotFoundError:
            return 127, "", f"找不到 adb：{self.adb}"
        except Exception as e:  # noqa: BLE001
            return 1, "", str(e)

    def _sh(self, script, timeout=15):
        """设备端 root shell（su -c '<script>'）"""
        return self._adb([script], timeout=timeout, root=True)

    # ---- 连接与预检 ----
    def connect(self, try_fallback=True):
        ports = [self.port] + [p for p in FALLBACK_PORTS if p != self.port] \
            if try_fallback else [self.port]
        last_err = ""
        for port in ports:
            self.port, self.serial = port, f"127.0.0.1:{port}"
            rc, out, err = self._adb(["connect", self.serial], timeout=10)
            rc2, devs, _ = self._adb(["devices"], timeout=10)
            if f"{self.serial}\tdevice" in devs:
                self.log(f"✅ adb 已连接 {self.serial}")
                info = self.device_info()
                if info:
                    self.log(f"   设备：{info}")
                return port
            last_err = (out + " " + err).strip() or devs
        raise RuntimeError(
            f"连接失败（试过 {ports}）：{last_err}——确认 MuMu 已启动、设置里开了 ADB 调试"
        )

    def device_info(self):
        rc, abi, _ = self._sh("getprop ro.product.cpu.abi")
        if rc != 0:
            _, abi, _ = self._adb(["shell", "getprop ro.product.cpu.abi"])
        rc, ver, _ = self._sh("getprop ro.build.version.release")
        _, root_out, _ = self._sh("id")
        root = "uid=0" in root_out
        _, td, _ = self._sh(f"ls {DEVICE_TCPDUMP}")
        has_td = rc == 0 and "/system/bin/tcpdump" in td
        self.root_ok = root
        self.tcpdump_ok = has_td
        parts = []
        if abi:
            parts.append(f"ABI={abi}")
        if ver:
            parts.append(f"Android {ver}")
        parts.append("root✓" if root else "root✗(开 MuMu root 权限)")
        parts.append("tcpdump✓" if has_td else "tcpdump✗")
        return " / ".join(parts)

    def find_interface(self):
        rc, out, _ = self._sh("ip -o link show")
        if rc == 0:
            for line in out.splitlines():
                m = re.match(r"\d+:\s+(\w+):.*state UP", line)
                if m and m.group(1) != "lo":
                    self.interface = m.group(1)
                    return self.interface
        return self.interface  # 兜底 wlan0

    # ---- 抓包生命周期 ----
    def running_pid(self):
        rc, out, _ = self._sh("ps -A | grep tcpdump | grep -v grep")
        if rc == 0 and out.strip():
            m = re.search(r"\b(\d+)\s+\d+\s+\S*\s*tcpdump", out)
            return m.group(1) if m else out.split()[1]
        return None

    def start_capture(self, prefix="xyzw"):
        if self.running_pid():
            raise RuntimeError("设备上已有 tcpdump 在跑——先点「停止并拉回」")
        ts = datetime.now().strftime("%H%M%S")
        device_file = f"{DEVICE_TMP_DIR}/{prefix}_{ts}.pcap"
        iface = self.find_interface()
        script = (
            f"nohup {DEVICE_TCPDUMP} -i {iface} -s 0 -U -w {device_file} "
            f">/dev/null 2>&1 &"
        )
        rc, out, err = self._sh(script, timeout=15)
        time.sleep(1.5)
        pid = self.running_pid()
        if not pid:
            raise RuntimeError(f"tcpdump 启动失败：{out} {err}")
        self._save_state(device_file)
        self.log(f"🔴 抓包中：{device_file}（PID {pid}，网卡 {iface}）")
        return device_file

    def stop_capture(self):
        pid = self.running_pid()
        if pid:
            self._sh("pkill -INT tcpdump", timeout=10)
            for _ in range(10):
                time.sleep(0.4)
                if not self.running_pid():
                    break
            if self.running_pid():
                raise RuntimeError("tcpdump 没停干净（INT 无效）——手动排查")
            self.log("⏹ 已停止 tcpdump（SIGINT 正常收尾）")
        else:
            self.log("（设备上没有在跑的 tcpdump）")

    def latest_device_pcap(self):
        rc, out, _ = self._sh(f"ls -t {DEVICE_TMP_DIR}/*.pcap 2>/dev/null | head -1")
        return out.strip() if rc == 0 and out.strip() else None

    def pull(self, device_file, dest_dir, prefix="xyzw"):
        os.makedirs(dest_dir, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        local = os.path.join(dest_dir, f"{prefix}_{stamp}.pcap")
        rc, out, err = self._adb(
            ["pull", device_file, local], timeout=120
        )
        if rc != 0 or not os.path.isfile(local):
            raise RuntimeError(f"pull 失败：{out} {err}")
        size = os.path.getsize(local)
        self.log(f"📦 已拉回：{local}（{size/1024:.0f} KB）")
        self._clear_state()
        return local

    def pcap_size(self, device_file):
        rc, out, _ = self._sh(f"ls -la {device_file} 2>/dev/null")
        if rc == 0:
            m = re.search(r"\s(\d+)\s+\d{4}-", out)
            if m:
                return int(m.group(1))
        return None

    # ---- 状态文件（GUI 重开后还能停+拉回）----
    def _save_state(self, device_file):
        try:
            import json
            with open(STATE_FILE, "w", encoding="utf-8") as f:
                json.dump(
                    {"device_file": device_file, "port": self.port,
                     "started_at": time.time()}, f,
                )
        except OSError:
            pass

    def _clear_state(self):
        try:
            os.remove(STATE_FILE)
        except OSError:
            pass

    def load_state(self):
        try:
            import json
            with open(STATE_FILE, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None


# ────────────────────── WS 帧提取（可选，纯标准库） ──────────────────────

def _read_pcap(path):
    data = open(path, "rb").read()
    magic = data[:4]
    if magic == b"\xd4\xc3\xb2\xa1":
        endian, nano = "<", False
    elif magic == b"\xa1\xb2\xc3\xd4":
        endian, nano = ">", False
    elif magic == b"\x4d\x3c\xb2\xa1":
        endian, nano = "<", True
    elif magic == b"\xa1\xb2\x3c\x4d":
        endian, nano = ">", True
    else:
        raise ValueError(f"不是 pcap：{magic.hex()}")
    off, pkts = 24, []
    while off + 16 <= len(data):
        ts, tu, incl, _orig = struct.unpack(endian + "IIII", data[off:off + 16])
        off += 16
        pkts.append(data[off:off + incl])
        off += incl
    return pkts


def _reassemble_tcp(packets):
    """Ethernet/VLAN→IPv4→TCP，按 (五元组, 方向) 重组。返回 {key: {1:[(seq,payload)],2:[...]}}"""
    streams = {}

    def add(key, direction, seq, payload):
        streams.setdefault(key, {1: [], 2: []})[direction].append((seq, payload))

    for frame in packets:
        if len(frame) < 14:
            continue
        ethertype = struct.unpack(">H", frame[12:14])[0]
        ipoff = 14
        if ethertype == 0x8100:
            if len(frame) < 18:
                continue
            ethertype = struct.unpack(">H", frame[16:18])[0]
            ipoff = 18
        if ethertype != 0x0800:
            continue
        ip = frame[ipoff:]
        if len(ip) < 20 or (ip[0] >> 4) != 4:
            continue
        ihl = (ip[0] & 0x0F) * 4
        if ip[9] != 6 or len(ip) < ihl + 20:
            continue
        src, dst = ip[12:16], ip[16:20]
        l4 = ip[ihl:]
        sport, dport = struct.unpack(">HH", l4[:4])
        seq = struct.unpack(">I", l4[4:8])[0]
        doff = (l4[12] >> 4) * 4
        payload = l4[doff:]
        if not payload:
            continue
        k1 = (src, sport, dst, dport)
        k2 = (dst, dport, src, sport)
        ck = min(k1, k2)
        add(ck, 1 if ck == k1 else 2, seq, payload)
    return streams


def _join(segs):
    if not segs:
        return b""
    segs = sorted(segs, key=lambda x: x[0])
    out, expected = bytearray(), segs[0][0]
    for seq, pl in segs:
        if seq + len(pl) <= expected:
            continue
        if seq > expected:
            out += b"\x00" * (seq - expected)
            expected = seq
        out += pl[expected - seq:]
        expected = seq + len(pl)
    return bytes(out)


def _ws_frames(stream, is_client):
    """解析 RFC6455 帧；client 方向 unmask。返回 [(opcode, payload)]
    有 HTTP 握手则跳过握手头；没有（连接建立于抓包开始前 / 无握手协议）则从字节 0 直接解。"""
    idx = stream.find(b"\r\n\r\n")
    pos, n, frames = (idx + 4 if idx >= 0 else 0), len(stream), []
    while pos + 2 <= n:
        opcode = stream[pos] & 0x0F
        masked = stream[pos + 1] >> 7
        ln = stream[pos + 1] & 0x7F
        pos += 2
        if ln == 126:
            if pos + 2 > n:
                break
            ln = struct.unpack(">H", stream[pos:pos + 2])[0]
            pos += 2
        elif ln == 127:
            if pos + 8 > n:
                break
            ln = struct.unpack(">Q", stream[pos:pos + 8])[0]
            pos += 8
        mask = None
        if masked:
            if pos + 4 > n:
                break
            mask = stream[pos:pos + 4]
            pos += 4
        if pos + ln > n:
            break
        pl = stream[pos:pos + ln]
        pos += ln
        if masked and mask:
            pl = bytes(b ^ mask[i % 4] for i, b in enumerate(pl))
        frames.append((opcode, pl))
    return frames


def _merge_continuation(frames):
    out = []
    for opcode, pl in frames:
        if opcode == 0 and out:
            prev = out[-1]
            out[-1] = (prev[0], prev[1] + pl)
        elif opcode in (1, 2):
            out.append((opcode, pl))
    return out


def extract_ws_frames(pcap_path, logfn=print):
    """抽明文 WS 帧到 <pcap>_streams/。返回摘要行列表。"""
    out_dir = pcap_path + "_streams"
    os.makedirs(out_dir, exist_ok=True)
    streams = _reassemble_tcp(_read_pcap(pcap_path))
    pairs = []
    for key, dirs in streams.items():
        c2s, s2c = _join(dirs[1]), _join(dirs[2])
        if not c2s and not s2c:
            continue
        low = (c2s[:2048] + s2c[:2048]).lower()
        # WS 识别：有 HTTP 升级头，或任一方向首字节 = 0x8x（WS 帧头，连接先于抓包建立时无握手）
        looks_ws = (
            b"upgrade: websocket" in low
            or c2s[:4] in (b"GET ", b"POST")
            or (c2s[:1] and 0x80 <= c2s[0] <= 0x8F and (c2s[0] & 0x0F) in (1, 2))
            or (s2c[:1] and 0x80 <= s2c[0] <= 0x8F and (s2c[0] & 0x0F) in (1, 2))
        )
        if looks_ws:
            pairs.append((key, c2s, s2c))
    pairs.sort(key=lambda p: -(len(p[1]) + len(p[2])))
    lines = [f"WS 流 {len(pairs)} 条 → {out_dir}"]
    for i, (key, c2s, s2c) in enumerate(pairs):
        src = ".".join(map(str, key[0])) + f":{key[1]}"
        dst = ".".join(map(str, key[2])) + f":{key[3]}"
        count = {}
        for tag, data in (("c2s", c2s), ("s2c", s2c)):
            frames = _merge_continuation(_ws_frames(data, tag == "c2s"))
            fname = os.path.join(out_dir, f"s{i:02d}_{tag}.frames.txt")
            with open(fname, "w", encoding="utf-8") as f:
                for j, (opcode, pl) in enumerate(frames):
                    if opcode == 2:
                        f.write(f"{j:05d} 2 {pl.hex()}\n")
                    elif opcode == 1:
                        f.write(f"{j:05d} 1 {pl.decode('utf-8', 'replace')}\n")
            heads = {}
            for _op, pl in frames:
                if pl[:1] == b"p":
                    heads[pl[:2].hex()] = heads.get(pl[:2].hex(), 0) + 1
            count[tag] = (len(frames), heads)
        c_n, c_h = count["c2s"]
        s_n, s_h = count["s2c"]
        lines.append(
            f"  s{i:02d} {src} → {dst}  c2s={c_n}帧{c_h or ''} s2c={s_n}帧{s_h or ''}"
        )
    if not pairs:
        lines.append("  （没找到明文 WebSocket 流——若游戏走 wss/443 则 tcpdump 抓不到明文）")
    for ln in lines:
        logfn(ln)
    return lines


# ────────────────────────────── CLI ──────────────────────────────

def cli_main(argv):
    log = lambda msg: print(f"[{now_text()}] {msg}")  # noqa: E731
    adb = find_adb()
    if not adb:
        print("找不到 adb.exe——请安装 MuMu 或把 adb 加入 PATH")
        return 1
    cmd = argv[0] if argv else "connect"
    cap = MuMuCapture(adb, DEFAULT_PORT, log)
    if cmd == "connect":
        cap.connect()
        return 0
    if cmd == "status":
        cap.connect()
        pid = cap.running_pid()
        state = cap.load_state()
        log(f"tcpdump PID: {pid or '无'}  state: {state}")
        return 0
    if cmd == "start":
        cap.connect()
        cap.device_info()
        f = cap.start_capture(argv[1] if len(argv) > 1 else "xyzw")
        log(f"抓包文件：{f}")
        return 0
    if cmd == "stop":
        cap.connect()
        cap.stop_capture()
        state = cap.load_state() or {}
        device_file = state.get("device_file") or cap.latest_device_pcap()
        if not device_file:
            log("（设备上没找到 pcap）")
            return 1
        local = cap.pull(device_file, repo_captures_dir(),
                         state.get("prefix", "xyzw"))
        extract_ws_frames(local, log)
        return 0
    if cmd == "auto":
        cap.connect()
        cap.device_info()
        device_file = cap.start_capture("selftest")
        log("… 抓 5 秒 …")
        time.sleep(5)
        cap.stop_capture()
        local = cap.pull(device_file, repo_captures_dir(), "selftest")
        extract_ws_frames(local, log)
        return 0
    print(f"未知命令：{cmd}（connect/status/start/stop/auto）")
    return 1


# ────────────────────────────── GUI ──────────────────────────────

class App:
    def __init__(self, root):
        self.root = root
        root.title("MuMu 抓包工具 · xyzw 协议逆向")
        root.geometry("860x620")
        root.minsize(760, 520)

        self.q = queue.Queue()
        self.capturing = False
        self.device_file = None
        self.cap = None

        outer = ttk.Frame(root, padding=10)
        outer.pack(fill="both", expand=True)
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(3, weight=1)

        # ── 设备连接 ──
        lf1 = ttk.LabelFrame(outer, text=" ① 设备连接 ", padding=8)
        lf1.grid(row=0, column=0, sticky="ew")
        lf1.columnconfigure(0, weight=1)
        row1 = ttk.Frame(lf1)
        row1.grid(sticky="ew")
        row1.columnconfigure(0, weight=1)
        self.var_adb = tk.StringVar(value=find_adb() or "")
        ttk.Label(row1, text="adb:").pack(side="left")
        ttk.Entry(row1, textvariable=self.var_adb).pack(
            side="left", fill="x", expand=True, padx=(4, 4)
        )
        ttk.Button(row1, text="…", width=3,
                   command=self.pick_adb).pack(side="left", padx=(0, 8))
        ttk.Label(row1, text="端口:").pack(side="left")
        self.var_port = tk.StringVar(value=str(DEFAULT_PORT))
        ttk.Entry(row1, textvariable=self.var_port, width=7).pack(
            side="left", padx=(4, 8)
        )
        self.btn_connect = ttk.Button(row1, text="连接设备",
                                      command=self.on_connect)
        self.btn_connect.pack(side="left")
        self.var_devinfo = tk.StringVar(value="未连接")
        ttk.Label(lf1, textvariable=self.var_devinfo, foreground="#666").grid(
            sticky="w", pady=(6, 0)
        )

        # ── 抓包 ──
        lf2 = ttk.LabelFrame(outer, text=" ② 抓包（tcpdump · wlan0 · 明文 ws）", padding=8)
        lf2.grid(row=1, column=0, sticky="ew", pady=(8, 0))
        lf2.columnconfigure(1, weight=1)
        row2 = ttk.Frame(lf2)
        row2.grid(sticky="ew", pady=(0, 6))
        ttk.Label(row2, text="文件前缀:").pack(side="left")
        self.var_prefix = tk.StringVar(value="xyzw")
        ttk.Entry(row2, textvariable=self.var_prefix, width=12).pack(
            side="left", padx=(4, 12)
        )
        ttk.Label(row2, text="保存目录:").pack(side="left")
        self.var_dest = tk.StringVar(value=repo_captures_dir())
        ttk.Entry(row2, textvariable=self.var_dest).pack(
            side="left", fill="x", expand=True, padx=4
        )
        ttk.Button(row2, text="…", width=3,
                   command=self.pick_dest).pack(side="left", padx=(0, 8))
        row3 = ttk.Frame(lf2)
        row3.grid(sticky="ew")
        self.btn_start = ttk.Button(row3, text="▶ 开始抓包",
                                    command=self.on_start, state="disabled")
        self.btn_start.pack(side="left")
        self.btn_stop = ttk.Button(row3, text="■ 停止并拉回",
                                   command=self.on_stop, state="disabled")
        self.btn_stop.pack(side="left", padx=(8, 12))
        self.var_extract = tk.BooleanVar(value=True)
        ttk.Checkbutton(row3, text="拉回后自动抽 WS 帧（frames.txt）",
                        variable=self.var_extract).pack(side="left")
        self.var_status = tk.StringVar(value="空闲")
        ttk.Label(lf2, textvariable=self.var_status, foreground="#0a7a0a").grid(
            sticky="w", pady=(6, 0)
        )

        # ── 日志 ──
        lf3 = ttk.LabelFrame(outer, text=" 日志 ", padding=6)
        lf3.grid(row=3, column=0, sticky="nsew", pady=(8, 0))
        self.txt = tkscrolled.ScrolledText(lf3, height=14, state="disabled",
                                           font=("Consolas", 9))
        self.txt.pack(fill="both", expand=True)

        self.log(f"工具就绪。adb 自动检测：{self.var_adb.get() or '（未找到，手动指定）'}")
        self.log("流程：连MuMu → 开始抓包 → 游戏里操作 → 停止并拉回（pcap + frames.txt）")

        self.root.after(100, self._drain_queue)
        self._poll_after_id = None

    # ---------- 日志 ----------
    def log(self, msg):
        self.txt.configure(state="normal")
        self.txt.insert("end", f"[{now_text()}] {msg}\n")
        self.txt.see("end")
        self.txt.configure(state="disabled")

    # ---------- 后台线程 → 队列 → UI ----------
    def run_bg(self, fn, done=None):
        def worker():
            try:
                result = fn()
                self.q.put(("done", done, result))
            except Exception as e:  # noqa: BLE001
                self.q.put(("error", e, None))
        threading.Thread(target=worker, daemon=True).start()

    def _drain_queue(self):
        try:
            while True:
                kind, payload, extra = self.q.get_nowait()
                if kind == "log":
                    self.log(payload)
                elif kind == "error":
                    self.log(f"❌ {payload}")
                    self._set_idle()
                elif kind == "done":
                    if payload:
                        payload(extra)
                elif kind == "poll":
                    self._update_poll(payload)
        except queue.Empty:
            pass
        self.root.after(100, self._drain_queue)

    def _set_idle(self):
        self.capturing = False
        self.btn_connect.configure(state="normal")
        self.btn_start.configure(
            state="normal" if self.var_devinfo.get() != "未连接" else "disabled"
        )
        self.btn_stop.configure(state="disabled")
        self.var_status.set("空闲")

    # ---------- 连接 ----------
    def pick_adb(self):
        p = tkfiledialog.askopenfilename(
            title="选择 adb.exe", filetypes=[("adb.exe", "adb.exe"), ("全部", "*.*")]
        )
        if p:
            self.var_adb.set(p)

    def pick_dest(self):
        p = tkfiledialog.askdirectory(title="选择保存目录")
        if p:
            self.var_dest.set(p)

    def on_connect(self):
        adb = self.var_adb.get().strip()
        if not adb or not os.path.isfile(adb):
            adb = find_adb()
            if not adb:
                self.log("❌ 找不到 adb.exe——点「…」手动指定 MuMu 的 adb 路径")
                return
            self.var_adb.set(adb)
        try:
            port = int(self.var_port.get().strip() or DEFAULT_PORT)
        except ValueError:
            self.log("❌ 端口必须是数字")
            return
        self.btn_connect.configure(state="disabled")
        self.var_devinfo.set("连接中…")

        def job():
            cap = MuMuCapture(adb, port, lambda m: self.q.put(("log", m, None)))
            found_port = cap.connect()
            return cap, found_port

        def done(res):
            cap, found_port = res
            self.cap = cap
            self.var_port.set(str(found_port))
            self.var_devinfo.set(cap.device_info() or "已连接")
            if not getattr(cap, "root_ok", False):
                self.log("⚠️ 无 root：MuMu 设置 → 开启 root 权限后重连")
            if not getattr(cap, "tcpdump_ok", False):
                self.log("⚠️ 设备上没有 /system/bin/tcpdump——找 WorkBuddy 处理")
            if cap.running_pid():
                self.log("⚠️ 设备上已有 tcpdump 在跑——直接点「停止并拉回」接管")
                self.capturing = True
                self._set_capturing_ui()
                state = cap.load_state()
                self.device_file = (state or {}).get("device_file") \
                    or cap.latest_device_pcap()
            else:
                self.btn_start.configure(state="normal")
            self.btn_connect.configure(state="normal")

        self.run_bg(job, done)

    # ---------- 开始 ----------
    def _set_capturing_ui(self):
        self.btn_start.configure(state="disabled")
        self.btn_stop.configure(state="normal")
        self.var_status.set("抓包中…")
        self.var_status.foreground = "#c22"
        self._schedule_poll()

    def on_start(self):
        if not self.cap:
            self.on_connect()
            if not self.cap:
                return
        prefix = self.var_prefix.get().strip() or "xyzw"
        self.btn_start.configure(state="disabled")

        def job():
            if not self.cap.root_ok or not self.cap.tcpdump_ok:
                self.cap.device_info()
            return self.cap.start_capture(prefix)

        def done(device_file):
            self.capturing = True
            self.device_file = device_file
            self._set_capturing_ui()

        self.run_bg(job, done)

    def _schedule_poll(self):
        if not self.capturing:
            return
        self._poll_after_id = self.root.after(2000, self._poll_once)

    def _poll_once(self):
        if not self.capturing or not self.cap or not self.device_file:
            return
        cap, df = self.cap, self.device_file

        def job():
            size = cap.pcap_size(df)
            pid = cap.running_pid()
            return size, pid

        def done(res):
            size, pid = res
            if not self.capturing:
                return
            if size is None:
                self.var_status.set("抓包中…（文件未就绪）")
            else:
                self.var_status.set(f"抓包中… 设备端 {size/1024:.0f} KB")
            if pid is None and size is not None and size > 0:
                self.log("⚠️ tcpdump 进程消失了（可能被系统杀）——点「停止并拉回」保住数据")
                self.btn_stop.configure(state="normal")
            self._schedule_poll()

        self.run_bg(job, done)

    # ---------- 停止 + 拉回 ----------
    def on_stop(self):
        if not self.cap:
            return
        self.btn_stop.configure(state="disabled")
        self.var_status.set("停止中…")
        prefix = self.var_prefix.get().strip() or "xyzw"
        dest = self.var_dest.get().strip() or repo_captures_dir()
        cap = self.cap
        device_file = self.device_file

        def job():
            cap.stop_capture()
            df = device_file or (cap.load_state() or {}).get("device_file") \
                or cap.latest_device_pcap()
            if not df:
                raise RuntimeError("设备上没找到 pcap 文件")
            local = cap.pull(df, dest, prefix)
            return local

        def done(local):
            self.capturing = False
            self.device_file = None
            if self._poll_after_id:
                self.root.after_cancel(self._poll_after_id)
                self._poll_after_id = None
            self.var_status.set("已拉回 ✓")
            if self.var_extract.get():
                self.var_status.set("抽帧中…")
                self.run_bg(lambda: extract_ws_frames(local, lambda m: self.q.put(("log", m, None))),
                            done=lambda _r: self._set_idle())
            else:
                self._set_idle()
            self.log("完成。BON 解码分析把 pcap/frames 路径发给 WorkBuddy 即可。")

        self.run_bg(job, done)


def gui_main():
    root = tk.Tk()
    try:
        ttk.Style().theme_use("vista")
    except tk.TclError:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    if "--cli" in sys.argv:
        i = sys.argv.index("--cli")
        sys.exit(cli_main(sys.argv[i + 1:]))
    gui_main()
