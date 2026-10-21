// 목록에서는 IPv4와 IPv6 등 IP별 바인딩을 하나의 포트 매핑으로 표시한다.
export function publicPortMappings(ports = []) {
  const seen = new Set();
  return ports.filter((port) => {
    if (!port.PublicPort) return false;
    const key = `${port.PublicPort}:${port.PrivatePort}/${port.Type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
