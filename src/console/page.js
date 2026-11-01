/**
 * 控制台页面（单文件，无构建）
 */

export const CONSOLE_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qqbridge-v2</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#e6e9ef; --muted:#8b93a7; --accent:#6ea8fe; --warn:#f2b45c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 system-ui,"Segoe UI",sans-serif; }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:14px; align-items:center; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  .tag { color:var(--muted); font-size:12px; }
  main { padding:20px; max-width:1000px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; }
  .panel h2 { font-size:13px; margin:0 0 12px; color:var(--muted); font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:500; }
  .chip { padding:1px 8px; border-radius:999px; background:#1f2530; color:var(--muted); font-size:12px; }
  pre { white-space:pre-wrap; margin:0; font:12px/1.6 ui-monospace,monospace; color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>qqbridge-v2</h1>
  <span class="tag" id="tag">loading…</span>
</header>
<main>
  <div class="panel"><h2>健康</h2><pre id="health"></pre></div>
  <div class="panel"><h2>统计</h2><pre id="stats"></pre></div>
  <div class="panel"><h2>归档会话（仅运维可见；AI 只能靠记忆命中 sessionId）</h2>
    <table><thead><tr><th>时间范围</th><th>会话</th><th>代次</th><th>消息</th><th>摘要</th></tr></thead><tbody id="archives"></tbody></table>
    <pre id="archiveDetail" style="margin-top:12px"></pre>
  </div>
  <div class="panel"><h2>会话</h2>
    <table><thead><tr><th>会话</th><th>类型</th><th>最后消息</th></tr></thead><tbody id="sessions"></tbody></table>
  </div>
</main>
<script>
const token = new URLSearchParams(location.search).get('token') || localStorage.getItem('qqb_token') || '';
if (token) localStorage.setItem('qqb_token', token);
const auth = token ? { authorization: 'Bearer ' + token } : {};
const get = async (p) => (await fetch(p, { headers: auth })).json();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function tick() {
  try {
    const [h, s, ss] = await Promise.all([get('/health'), get('/stats'), get('/sessions')]);
    document.getElementById('tag').textContent = '运行 ' + Math.round((h.uptimeMs ?? 0) / 1000) + 's';
    document.getElementById('health').textContent = JSON.stringify(h, null, 2);
    document.getElementById('stats').textContent = JSON.stringify(s, null, 2);
    document.getElementById('sessions').innerHTML = (ss.sessions ?? []).map((x) => \`
      <tr><td>\${esc(x.sessionKey)}</td><td><span class="chip">\${esc(x.kind)}</span></td><td>\${esc((x.lastEventAt ?? '').slice(0,19))}</td></tr>\`).join('')
      || '<tr><td colspan="3" class="muted">暂无会话</td></tr>';
  } catch (e) {
    document.getElementById('tag').textContent = '控制台请求失败';
  }
}
tick(); setInterval(tick, 5000);
</script>
</body>
</html>`;
