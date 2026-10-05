const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeRpc(url) {
  let id = 0;
  return async function rpc(method, params = [], { retries = 5 } = {}) {
    let wait = 500;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        });
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`RPC ${res.status}`), { retry: true });
        const body = await res.json();
        if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { retry: body.error.code === -32005 });
        return body.result;
      } catch (e) {
        const retryable = e.retry || e.name === 'TypeError' || e.cause; // network errors
        if (!retryable || attempt >= retries) throw e;
        await sleep(wait);
        wait = Math.min(wait * 2, 8000);
      }
    }
  };
}
