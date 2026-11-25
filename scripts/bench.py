#!/usr/bin/env python3
"""Naru 성능 기준 측정 스크립트.

Windows CLI 기준(run/exec/version/copy)과 WSL 엔진 API 단계별(create/start/wait/delete)
소요 시간의 p50, p99를 ms 단위로 측정한다.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path


WSL_API_BENCH = r"""
import http.client
import json
import socket
import sys
import time

SOCK = "/run/naru/docker.sock"
IMAGE = sys.argv[1]
RUNS = int(sys.argv[2])
MODES = sys.argv[3].split(",")


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost")
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.path)


def req(method, path, body=None):
    conn = UnixHTTPConnection(SOCK)
    headers = {}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    if resp.status >= 400:
        raise RuntimeError(f"{method} {path} -> {resp.status}: {raw.decode('utf-8', 'replace')}")
    return json.loads(raw) if raw else {}


def pct(values, p):
    if not values:
        return 0.0
    s = sorted(values)
    idx = min(len(s) - 1, max(0, int(round((p / 100.0) * (len(s) - 1)))))
    return round(s[idx], 1)


out = {}
for mode in MODES:
    stages = {k: [] for k in ("create", "start", "wait", "delete", "total")}
    body = {
        "Image": IMAGE,
        "Cmd": ["true"],
        "HostConfig": {"NetworkMode": mode},
    }
    for _ in range(RUNS):
        t0 = time.perf_counter()
        cid = req("POST", "/containers/create", body)["Id"]
        t1 = time.perf_counter()
        req("POST", f"/containers/{cid}/start")
        t2 = time.perf_counter()
        req("POST", f"/containers/{cid}/wait")
        t3 = time.perf_counter()
        req("DELETE", f"/containers/{cid}?force=1")
        t4 = time.perf_counter()
        stages["create"].append((t1 - t0) * 1000)
        stages["start"].append((t2 - t1) * 1000)
        stages["wait"].append((t3 - t2) * 1000)
        stages["delete"].append((t4 - t3) * 1000)
        stages["total"].append((t4 - t0) * 1000)
    out[mode] = {
        k: {"p50": pct(v, 50), "p99": pct(v, 99)}
        for k, v in stages.items()
    }

print(json.dumps(out))
"""


def pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    idx = min(len(s) - 1, max(0, int(round((p / 100.0) * (len(s) - 1)))))
    return round(s[idx], 1)


def run_cmd(cmd: list[str]) -> float:
    t0 = time.perf_counter()
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    elapsed = (time.perf_counter() - t0) * 1000.0
    if proc.returncode != 0:
        raise RuntimeError(f"명령 실패 ({' '.join(cmd)}): {proc.stderr.strip()}")
    return elapsed


def ensure_image(docker: str, image: str) -> None:
    check = subprocess.run([docker, "image", "inspect", image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if check.returncode != 0:
        subprocess.run([docker, "pull", image], check=True)


def bench_cli(docker: str, image: str, runs: int, copy_mb: int) -> dict:
    ensure_image(docker, image)
    results = {}

    for label, cmd in [
        ("run_bridge", [docker, "run", "--rm", image, "true"]),
        ("run_none", [docker, "run", "--rm", "--network", "none", image, "true"]),
        ("version", [docker, "version", "--format", "{{.Client.Version}}"]),
    ]:
        samples = [run_cmd(cmd) for _ in range(runs)]
        results[label] = {"p50": pct(samples, 50), "p99": pct(samples, 99)}

    # exec true
    cid = subprocess.check_output(
        [docker, "run", "-d", "--rm", "--network", "none", image, "sleep", "300"],
        text=True,
    ).strip()
    try:
        exec_samples = [run_cmd([docker, "exec", cid, "true"]) for _ in range(runs)]
        results["exec_true"] = {"p50": pct(exec_samples, 50), "p99": pct(exec_samples, 99)}

        # container -> Windows copy
        if copy_mb > 0:
            subprocess.run(
                [docker, "exec", cid, "dd", "if=/dev/zero", "of=/tmp/bench.bin", "bs=1M", f"count={copy_mb}"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
            )
            with tempfile.TemporaryDirectory(prefix="naru-bench-") as tmp:
                dest = Path(tmp) / "bench.bin"
                copy_samples = []
                for _ in range(min(5, runs)):
                    if dest.exists():
                        dest.unlink()
                    copy_samples.append(run_cmd([docker, "cp", f"{cid}:/tmp/bench.bin", str(dest)]))
                p50 = pct(copy_samples, 50)
                mb_s = round((copy_mb / (p50 / 1000.0)), 1) if p50 > 0 else 0.0
                results["copy_mb"] = {"size_mb": copy_mb, "p50": p50, "mb_per_sec": mb_s}
    finally:
        subprocess.run([docker, "rm", "-f", cid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    return results


def bench_api(distro: str, image: str, runs: int, modes: list[str]) -> dict:
    proc = subprocess.run(
        ["wsl", "-d", distro, "--", "python3", "-c", WSL_API_BENCH, image, str(runs), ",".join(modes)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"WSL API 측정 실패: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def print_report(data: dict) -> None:
    if "cli" in data:
        cli = data["cli"]
        print("\n[Windows CLI (ms)]")
        print(f"{'항목':<28} {'p50':>8} {'p99':>8}")
        print("-" * 46)
        for key, title in [
            ("run_bridge", "run --rm (bridge)"),
            ("run_none", "run --rm (--network none)"),
            ("exec_true", "exec true"),
            ("version", "docker version"),
        ]:
            if key in cli:
                print(f"{title:<28} {cli[key]['p50']:>8.1f} {cli[key]['p99']:>8.1f}")
        if "copy_mb" in cli:
            c = cli["copy_mb"]
            print(f"{'copy ' + str(c['size_mb']) + 'MB (ms / MB/s)':<28} {c['p50']:>8.1f} {c['mb_per_sec']:>8.1f}")

    if "api" in data:
        api = data["api"]
        modes = list(api.keys())
        print("\n[엔진 API 단계별 p50 (ms)]")
        header = f"{'단계':<12}" + "".join(f"{m:>10}" for m in modes)
        print(header)
        print("-" * len(header))
        for stage in ("create", "start", "wait", "delete", "total"):
            row = f"{stage:<12}" + "".join(f"{api[m][stage]['p50']:>10.1f}" for m in modes)
            print(row)


def main() -> int:
    parser = argparse.ArgumentParser(description="Naru 컨테이너 시작 시간과 복사 처리량을 측정합니다.")
    parser.add_argument("--mode", choices=["all", "cli", "api"], default="all")
    parser.add_argument("--image", default="alpine:3.22")
    parser.add_argument("--cli-runs", type=int, default=30)
    parser.add_argument("--api-runs", type=int, default=20)
    parser.add_argument("--copy-mb", type=int, default=200)
    parser.add_argument("--distro", default="naru")
    parser.add_argument("--docker", default=shutil.which("docker") or "docker")
    parser.add_argument("--modes", default="none,bridge,host")
    parser.add_argument("--json", action="store_true", help="JSON 형식으로 출력")
    args = parser.parse_args()

    out = {"image": args.image}
    if args.mode in ("all", "cli"):
        out["cli"] = bench_cli(args.docker, args.image, args.cli_runs, args.copy_mb)
    if args.mode in ("all", "api"):
        if args.mode == "cli":
            ensure_image(args.docker, args.image)
        out["api"] = bench_api(args.distro, args.image, args.api_runs, [m.strip() for m in args.modes.split(",") if m.strip()])

    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print_report(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
