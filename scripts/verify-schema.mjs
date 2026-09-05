const base = process.env.ILAWO_PORTAL_URL || 'https://ilawo-financial-portal.vercel.app';
const res = await fetch(`${base}/api/health/data-model`, { headers: { 'cache-control': 'no-cache' } });
if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
if (!data.ready) process.exitCode = 1;
