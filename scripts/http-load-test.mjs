// HTTP Concurrency Load Test against live localhost:8787
const BASE_URL = 'http://localhost:8787';

async function run() {
  console.log('🚀 開始真實 HTTP 併發壓力測試 (Target: http://localhost:8787)...');

  // 1. 併發 30 位使用者登入
  const userCount = 30;
  const loginStart = performance.now();
  const users = await Promise.all(
    Array.from({ length: userCount }, async (_, i) => {
      const email = `http_load_${Date.now()}_${i}@example.com`;
      const res = await fetch(`${BASE_URL}/api/auth/dev-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, nickname: `HTTP測試者${i + 1}` }),
      });
      if (!res.ok) {
        throw new Error(`Login failed for ${email}: ${res.status}`);
      }
      const setCookie = res.headers.get('set-cookie');
      const cookie = setCookie ? setCookie.split(';')[0] : '';
      const data = await res.json();
      return { id: data.data.user.id, cookie, email };
    })
  );
  const loginTime = performance.now() - loginStart;
  console.log(`✅ [1/4] ${userCount} 位使用者併發 HTTP 登入完成: ${loginTime.toFixed(1)} ms (${(userCount / (loginTime / 1000)).toFixed(0)} req/s)`);

  // 2. 5 位提供者併發提交連結（各 3 名額 = 15 名額）
  const providers = users.slice(0, 5);
  const linkStart = performance.now();
  await Promise.all(
    providers.map(async (p, idx) => {
      const code = `httpLoadCode${Date.now()}${idx}`;
      const res = await fetch(`${BASE_URL}/api/links`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: p.cookie,
        },
        body: JSON.stringify({
          rawUrlInput: `https://claude.ai/referral/${code}`,
          slotCount: 3,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Submit link failed: ${res.status} ${text}`);
      }
    })
  );
  const linkTime = performance.now() - linkStart;
  console.log(`✅ [2/4] 5 位提供者併發提交 15 名額完成: ${linkTime.toFixed(1)} ms (${(5 / (linkTime / 1000)).toFixed(0)} req/s)`);

  // 3. 25 位領取者同時發起搶排隊 (15 人獲配 reserved，10 人排隊 waiting)
  const receivers = users.slice(5, 30);
  const queueStart = performance.now();
  const queueResults = await Promise.all(
    receivers.map(async (r, idx) => {
      const res = await fetch(`${BASE_URL}/api/queue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: r.cookie,
        },
        body: JSON.stringify({
          thankYouMessage: `謝謝大大分享！HTTP 壓測小卡 ${idx + 1}`,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Join queue failed: ${res.status} ${text}`);
      }
      const data = await res.json();
      return { receiver: r, ...data.data };
    })
  );
  const queueTime = performance.now() - queueStart;
  const reservedCount = queueResults.filter((q) => q.status === 'reserved').length;
  const waitingCount = queueResults.filter((q) => q.status === 'waiting').length;
  console.log(
    `✅ [3/4] 25 位領取者併發搶排隊完成: ${queueTime.toFixed(1)} ms (${(25 / (queueTime / 1000)).toFixed(0)} req/s)` +
    ` ➔ 獲配: ${reservedCount} 位, 等候: ${waitingCount} 位`
  );

  // 4. 15 位獲配者併發解鎖與確認啟用
  const matchedReceivers = queueResults.filter((q) => q.status === 'reserved');
  const confirmStart = performance.now();
  await Promise.all(
    matchedReceivers.map(async ({ receiver }) => {
      // reveal
      const revealRes = await fetch(`${BASE_URL}/api/queue/reveal`, {
        method: 'POST',
        headers: { Cookie: receiver.cookie },
      });
      if (!revealRes.ok) throw new Error('Reveal failed');

      // confirm
      const confirmRes = await fetch(`${BASE_URL}/api/queue/confirm`, {
        method: 'POST',
        headers: { Cookie: receiver.cookie },
      });
      if (!confirmRes.ok) throw new Error('Confirm failed');
    })
  );
  const confirmTime = performance.now() - confirmStart;
  console.log(`✅ [4/4] 15 位獲配者併發解鎖與確認完成: ${confirmTime.toFixed(1)} ms (${(30 / (confirmTime / 1000)).toFixed(0)} req/s)`);

  // 驗證看板
  const boardRes = await fetch(`${BASE_URL}/api/board`);
  const boardData = await boardRes.json();
  console.log('\n📊 看板即時狀態:', JSON.stringify(boardData.data));
  console.log('🎉 真實 HTTP 壓力測試驗收通過！\n');
}

run().catch((err) => {
  console.error('❌ HTTP 壓測失敗:', err);
  process.exit(1);
});
