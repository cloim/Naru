/* Naru browser bridge for Docker Desktop extension clients. */
(() => {
  const id = location.hostname.split('.')[0];
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('naru-token') || sessionStorage.getItem('naru-extension-token:' + id);
  if (token) sessionStorage.setItem('naru-extension-token:' + id, token);
  if (params.has('naru-token')) history.replaceState(null, '', location.pathname + location.search);
  async function rpc(method, ...args) {
    const r = await fetch('/rpc/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': token },
      body: JSON.stringify({ method, args }),
    });
    const value = await r.json();
    if (!r.ok) throw new Error(value.error || 'Extension API error');
    return value;
  }
  const result = (value) => ({
    ...value,
    cmd: value.cmd || '',
    lines: () => value.stdout.split(/\r?\n/),
    parseJsonLines: () =>
      value.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    parseJsonObject: () => JSON.parse(value.stdout),
  });
  const exec =
    (scope) =>
    (cmd, args = [], options = {}) => {
      if (options.stream) {
        const abort = new AbortController();
        const stream = options.stream;
        const buffers = { stdout: '', stderr: '' };
        (async () => {
          try {
            const response = await fetch('/rpc/' + id, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Extension-Token': token },
              body: JSON.stringify({ method: 'exec-stream', args: [scope, cmd, args, options] }),
              signal: abort.signal,
            });
            if (!response.ok) throw new Error('Extension stream HTTP ' + response.status);
            const reader = response.body.getReader(),
              decoder = new TextDecoder();
            let pending = '';
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              pending += decoder.decode(value, { stream: true });
              let end;
              while ((end = pending.indexOf('\n')) !== -1) {
                const event = JSON.parse(pending.slice(0, end));
                pending = pending.slice(end + 1);
                if (event.error) throw new Error(event.error);
                if (event.code !== undefined) {
                  stream.onClose?.(event.code);
                  continue;
                }
                if (stream.splitOutputLines) {
                  for (const key of ['stdout', 'stderr'])
                    if (event[key]) {
                      buffers[key] += event[key];
                      let index;
                      while ((index = buffers[key].indexOf('\n')) !== -1) {
                        stream.onOutput?.({
                          [key]: buffers[key].slice(0, index).replace(/\r$/, ''),
                        });
                        buffers[key] = buffers[key].slice(index + 1);
                      }
                    }
                } else stream.onOutput?.(event);
              }
            }
          } catch (error) {
            if (error.name !== 'AbortError') stream.onError?.(error);
          }
        })();
        return {
          close() {
            abort.abort();
          },
        };
      }
      return rpc('exec', scope, cmd, args, options).then((value) => {
        const output = result(value);
        if (value.code) throw output;
        return output;
      });
    };
  const notify = (type, message) =>
    parent.postMessage(
      { type: 'naru-extension-message', level: type, message: String(message) },
      'http://127.0.0.1:' + String(Number(location.port) - 1),
    );
  const service = { request: (config) => rpc('service', config) };
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head'])
    service[method] = (url, data) =>
      rpc('service', {
        method: method.toUpperCase(),
        url,
        data,
        headers: typeof data === 'object' ? { 'Content-Type': 'application/json' } : {},
      });
  const host = {
    platform: 'win32',
    arch: 'x64',
    hostname: '',
    openExternal: (url) => notify('link', url),
  };
  const client = {
    extension: {
      id,
      image: '',
      version: '',
      vm: { cli: { exec: exec('container') }, service },
      host: { cli: { exec: exec('host') } },
    },
    docker: {
      cli: { exec: exec('docker-cli') },
      listContainers: (options) => rpc('containers', options || {}),
      listImages: (options) => rpc('images', options || {}),
      rdListVolumes: (options) => rpc('volumes', options || {}),
      listNamespaces: () => rpc('namespaces'),
    },
    host,
    desktopUI: {
      toast: {
        success: (message) => notify('success', message),
        warning: (message) => notify('warning', message),
        error: (message) => notify('error', message),
      },
      dialog: { showOpenDialog: (options) => rpc('dialog', options || {}) },
      navigate: {
        viewContainers: () => notify('navigate', '/'),
        viewImages: () => notify('navigate', '/images'),
        viewVolumes: () => notify('navigate', '/volumes'),
      },
    },
  };
  client.docker.rdSubscribeToEvents = (callback, options = {}) => {
    const args = ['--format', '{{json .}}'];
    for (const [type, values] of Object.entries(options.filters || {}))
      for (const value of values) args.push('--filter', `${type}=${value}`);
    const process = client.docker.cli.exec('events', args, {
      namespace: options.namespace,
      stream: {
        splitOutputLines: true,
        onOutput: ({ stdout }) => {
          if (stdout)
            try {
              callback(JSON.parse(stdout));
            } catch (error) {
              console.error(error);
            }
        },
        onError: console.error,
      },
    });
    return { unsubscribe: () => process.close() };
  };
  Object.defineProperty(window, 'ddClient', { value: client, writable: false });
  rpc('host')
    .then((value) => {
      Object.assign(host, value);
      client.extension.image = value.image;
      client.extension.id = value.id;
    })
    .catch(console.error);
})();
