// lucide-react 아이콘 노드를 SVG 문자열 사전으로 추출한다.
import { writeFileSync } from 'node:fs';
const names = ['container','layers','hard-drive','network','ship-wheel','camera','puzzle','plug-zap','history','activity','settings-2','play','square','rotate-cw','search','check','download','terminal','shield-check','box','chevron-right','circle-check','cpu','memory-stick','file-code','arrow-right-left','archive-restore','sparkles','github','monitor','zap','lock','package'];
const out = {};
for (const n of names) {
  try {
    const m = await import(`../node_modules/lucide-react/dist/esm/icons/${n}.js`);
    out[n] = m.__iconNode.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
  } catch { console.error('missing', n); }
}
writeFileSync(new URL('./icons.js', import.meta.url), `window.ICONS = ${JSON.stringify(out, null, 0)};\n`);
