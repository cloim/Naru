/**
 * 컨테이너 inspect 결과에서 마운트 및 볼륨 바인딩 목록을 정규화하여 추출합니다.
 * @param {object} inspect Docker/Podman container inspect JSON 객체
 * @returns {Array<{ Type: string, Name?: string, Source: string, Destination: string, Mode: string, RW: boolean, Propagation?: string, Driver?: string }>}
 */
export function getContainerMounts(inspect) {
  if (Array.isArray(inspect?.Mounts) && inspect.Mounts.length > 0) {
    return inspect.Mounts.map((m) => {
      const mode = m.Mode || (m.RW === false ? 'ro' : 'rw');
      const isRo = m.RW === false || String(mode).split(',').includes('ro');
      return {
        Type: m.Type || 'bind',
        Name: m.Name,
        Source: m.Source || m.Name || '',
        Destination: m.Destination || '',
        Mode: mode,
        RW: !isRo,
        Propagation: m.Propagation || '',
        Driver: m.Driver,
      };
    });
  }
  const binds = inspect?.HostConfig?.Binds;
  if (Array.isArray(binds) && binds.length > 0) {
    return binds.map((bind) => {
      const parts = String(bind).split(':');
      let source = parts[0] || '';
      let destination = parts[1] || '';
      let mode = parts[2] || 'rw';
      if (
        parts.length > 2 &&
        /^[a-zA-Z]$/.test(parts[0]) &&
        (parts[1]?.startsWith('\\') || parts[1]?.startsWith('/'))
      ) {
        source = `${parts[0]}:${parts[1]}`;
        destination = parts[2] || '';
        mode = parts[3] || 'rw';
      }
      const isPath =
        source.startsWith('/') ||
        source.startsWith('\\') ||
        source.includes(':\\') ||
        source.includes(':/') ||
        source.startsWith('.');
      const isRo = mode.split(',').includes('ro');
      return {
        Type: isPath ? 'bind' : 'volume',
        Name: isPath ? undefined : source,
        Source: source,
        Destination: destination,
        Mode: mode,
        RW: !isRo,
        Propagation: '',
      };
    });
  }
  return [];
}
