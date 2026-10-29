#!/usr/bin/env python3
"""Naru engine agent. naru-boot runs it inside the engine network namespace.

- Reports which engine ports Windows should open: Docker published ports, iptables DNAT ports
  (nerdctl and Kubernetes hostPort or LoadBalancer), --network host container listeners and
  kubectl port-forward listeners.
- Serves host.docker.internal: TCP to HOST_IP reaches Windows localhost through the Naru server,
  and DNS answers the Docker Desktop host names.
"""
import asyncio
import json
import os
import re
import secrets
import socket
import struct
import subprocess

CONTROL_PORT = 29171  # Naru server reaches it through the port relay.
HOST_PORT = 29172  # naru-boot redirects TCP for HOST_IP here.
HOST_IP = '198.19.249.254'
ENGINE_IP = '198.19.249.2'
HOST_NAMES = {'host.docker.internal', 'gateway.docker.internal'}
DOCKER_SOCKET = '/run/naru/docker.sock'
SO_ORIGINAL_DST = 80
UPSTREAM_MARK = 0x6E61  # naru-boot leaves DNS packets with this mark alone.

controls = []
pending = {}
targets = {}


# ---------- port discovery ----------

def listeners():
    """Maps socket inode to the relay target for every TCP listener in this namespace."""
    found = {}
    for path, loopback, wildcard in (
        ('/proc/net/tcp', '0100007F', '00000000'),
        ('/proc/net/tcp6', '00000000000000000000000001000000', '0' * 32),
    ):
        try:
            with open(path) as f:
                rows = f.read().splitlines()[1:]
        except FileNotFoundError:
            continue
        for row in rows:
            fields = row.split()
            if fields[3] != '0A':
                continue
            address, port = fields[1].split(':')
            if address not in (loopback, wildcard):
                continue
            host = '127.0.0.1' if path.endswith('tcp') else '[::1]'
            found[fields[9]] = f'{host}:{int(port, 16)}'
    return found


def owned_listeners(pids):
    sockets = listeners()
    result = []
    for pid in pids:
        try:
            for fd in os.listdir(f'/proc/{pid}/fd'):
                link = os.readlink(f'/proc/{pid}/fd/{fd}')
                if link.startswith('socket:[') and link[8:-1] in sockets:
                    result.append(sockets[link[8:-1]])
        except OSError:
            continue
    return result


def process_scan(host_containers):
    """Returns pids of --network host containers and kubectl processes.

    A listening kubectl is a port-forward or proxy. k3s rewrites its argv, so match the name only.
    """
    pids = []
    for pid in filter(str.isdigit, os.listdir('/proc')):
        try:
            with open(f'/proc/{pid}/comm') as f:
                if f.read().strip() == 'kubectl':
                    pids.append(pid)
                    continue
            if host_containers:
                with open(f'/proc/{pid}/cgroup') as f:
                    match = re.search(r'docker[-/]([0-9a-f]{64})', f.read())
                if match and match.group(1) in host_containers:
                    pids.append(pid)
        except OSError:
            continue
    return pids


def docker_get(route):
    if not os.path.exists(DOCKER_SOCKET):
        return []
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(5)
        s.connect(DOCKER_SOCKET)
        s.sendall(f'GET {route} HTTP/1.0\r\nHost: docker\r\n\r\n'.encode())
        data = b''
        while chunk := s.recv(65536):
            data += chunk
    head, _, body = data.partition(b'\r\n\r\n')
    if not head.startswith(b'HTTP/1.0 200') and not head.startswith(b'HTTP/1.1 200'):
        raise OSError(head.split(b'\r\n')[0].decode())
    return json.loads(body)


def dnat_ports():
    """Published ports implemented only by iptables DNAT, outside Docker's own chains."""
    try:
        text = subprocess.run(
            ['iptables-save', '-t', 'nat'], capture_output=True, text=True, timeout=5
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    # k3s leaves its hostPort rules (CNI network cbr0) behind when it stops; skip them until it runs again.
    try:
        with open('/run/naru/k3s.pid') as f:
            k3s_running = os.path.exists(f'/proc/{int(f.read())}')
    except (OSError, ValueError):
        k3s_running = False
    k3s_chains = set()
    for match in re.finditer(r'dnat name: \\"cbr0\\".*-j (CNI-DN-\w+)', text):
        k3s_chains.add(match.group(1))
    found = {}
    for line in text.splitlines():
        if not line.startswith('-A ') or '-j DNAT' not in line or ' -p tcp' not in line:
            continue
        chain = line.split()[1]
        if chain.startswith('DOCKER') or (chain in k3s_chains and not k3s_running):
            continue
        if f'--to-destination {HOST_IP}:' in line:  # naru-boot's own DNS redirect
            continue
        port = re.search(r'--dport (\d+)', line)
        if not port:
            continue
        host = '127.0.0.1' if re.search(r'-d 127\.0\.0\.1(/32)? ', line) else ENGINE_IP
        found[int(port.group(1))] = f'{host}:{port.group(1)}'
    return found


def discover():
    found = dnat_ports()
    host_containers = set()
    for container in docker_get('/containers/json'):
        if container.get('HostConfig', {}).get('NetworkMode') == 'host':
            host_containers.add(container['Id'])
        for p in container.get('Ports') or []:
            if p.get('Type') != 'tcp' or not p.get('PublicPort'):
                continue
            if p.get('IP') in ('0.0.0.0', '127.0.0.1'):
                found[p['PublicPort']] = f"127.0.0.1:{p['PublicPort']}"
            elif p.get('IP') == '::':
                found.setdefault(p['PublicPort'], f"[::1]:{p['PublicPort']}")
    for target in owned_listeners(process_scan(host_containers)):
        found.setdefault(int(target.rsplit(':', 1)[1]), target)
    return found


async def watch_ports():
    global targets
    while True:
        try:
            current = await asyncio.to_thread(discover)
            if current != targets:
                targets = current
                broadcast()
        except Exception as e:  # The next pass retries; Docker may still be starting.
            print(f'discover: {e}', flush=True)
        await asyncio.sleep(2)


# ---------- control channel ----------

def message(writer, value):
    writer.write((json.dumps(value) + '\n').encode())


def broadcast():
    items = [{'port': port, 'target': target} for port, target in sorted(targets.items())]
    for writer in controls:
        message(writer, {'type': 'targets', 'items': items})


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
        if writer.can_write_eof():
            writer.write_eof()
    except OSError:
        writer.close()


async def splice(a, b):
    await asyncio.gather(pipe(a[0], b[1]), pipe(b[0], a[1]))
    for _, writer in (a, b):
        writer.close()


async def on_control(reader, writer):
    """The Naru server opens one CONTROL connection, then one DATA connection per host request."""
    line = (await reader.readline()).decode().split()
    if line == ['CONTROL']:
        controls.append(writer)
        broadcast()
        try:
            while raw := await reader.readline():
                request = json.loads(raw)
                if request.get('type') == 'fail' and request.get('id') in pending:
                    pending.pop(request['id']).set_result(None)
        finally:
            controls.remove(writer)
            writer.close()
    elif len(line) == 2 and line[0] == 'DATA' and line[1] in pending:
        pending.pop(line[1]).set_result((reader, writer))
    else:
        writer.close()


# ---------- host.docker.internal ----------

async def on_host(reader, writer):
    sock = writer.get_extra_info('socket')
    port = struct.unpack('!2xH12x', sock.getsockopt(socket.SOL_IP, SO_ORIGINAL_DST, 16))[0]
    if not controls:
        writer.transport.abort()
        return
    request = secrets.token_hex(16)
    future = asyncio.get_running_loop().create_future()
    pending[request] = future
    message(controls[-1], {'type': 'open', 'id': request, 'port': port})
    try:
        windows = await asyncio.wait_for(future, 10)
    except asyncio.TimeoutError:
        windows = None
    pending.pop(request, None)
    if windows is None:
        # Nothing listens on Windows: reset like a closed port instead of a silent close.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
        writer.transport.abort()
        return
    await splice((reader, writer), windows)


def upstream_dns():
    with open('/etc/resolv.conf') as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 2 and parts[0] == 'nameserver' and parts[1] != HOST_IP:
                return parts[1]
    return '1.1.1.1'


def question(packet):
    """Returns (name, qtype, end offset) of the first question."""
    labels, offset = [], 12
    while length := packet[offset]:
        labels.append(packet[offset + 1 : offset + 1 + length].decode('ascii', 'replace'))
        offset += 1 + length
    qtype = struct.unpack('!H', packet[offset + 1 : offset + 3])[0]
    return '.'.join(labels).lower(), qtype, offset + 5


def host_answer(packet):
    name, qtype, end = question(packet)
    if name not in HOST_NAMES:
        return None
    flags = 0x8180 | (struct.unpack('!H', packet[2:4])[0] & 0x0100)
    answers = 1 if qtype == 1 else 0
    reply = packet[:2] + struct.pack('!HHHHH', flags, 1, answers, 0, 0) + packet[12:end]
    if answers:
        reply += struct.pack('!HHHIH', 0xC00C, 1, 1, 60, 4) + socket.inet_aton(HOST_IP)
    return reply


class Dns(asyncio.DatagramProtocol):
    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        asyncio.ensure_future(self.answer(data, addr))

    async def answer(self, data, addr):
        try:
            reply = host_answer(data)
            if reply is None:
                loop = asyncio.get_running_loop()
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, UPSTREAM_MARK)
                    s.setblocking(False)
                    await loop.sock_sendto(s, data, (upstream_dns(), 53))
                    reply, _ = await asyncio.wait_for(loop.sock_recvfrom(s, 65535), 5)
            self.transport.sendto(reply, addr)
        except (OSError, IndexError, struct.error, asyncio.TimeoutError):
            pass


async def on_dns_tcp(reader, writer):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, UPSTREAM_MARK)
    s.setblocking(False)
    try:
        await asyncio.get_running_loop().sock_connect(s, (upstream_dns(), 53))
        upstream = await asyncio.open_connection(sock=s)
    except OSError:
        s.close()
        writer.close()
        return
    await splice((reader, writer), upstream)


async def main():
    loop = asyncio.get_running_loop()
    await asyncio.start_server(on_control, '127.0.0.1', CONTROL_PORT)
    await asyncio.start_server(on_host, '0.0.0.0', HOST_PORT)
    await asyncio.start_server(on_dns_tcp, HOST_IP, 53)
    await loop.create_datagram_endpoint(Dns, local_addr=(HOST_IP, 53))
    print('naru-agent ready', flush=True)
    await watch_ports()


asyncio.run(main())
