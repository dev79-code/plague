// The infection rules. Applied once per transaction, in chain order, inside one
// SQLite transaction so a crash never leaves half an infection behind.
//
//  - Tokens leaving a pool vault owner  -> receiver is infected by the pool (a "buy").
//  - Tokens leaving an infected wallet  -> receiver is infected by that wallet,
//    as long as it receives at least MIN_INFECT and has never been infected.
//  - Vaccinated wallets (and wallets that were never infected) do not spread.
//  - Net supply going down = a burn. Once a wallet has burned VAX_BURN in total,
//    it is vaccinated: its score freezes and it stops spreading.

export function makeApplier(db, cfg) {
  const pool = new Set(cfg.poolOwners);
  const q = {
    seen: db.prepare('SELECT 1 FROM processed WHERE sig=?'),
    mark: db.prepare('INSERT OR IGNORE INTO processed(sig,slot,t) VALUES(?,?,?)'),
    get: db.prepare('SELECT * FROM wallets WHERE address=?'),
    bal: db.prepare(`INSERT INTO wallets(address,balance) VALUES(?,?)
                     ON CONFLICT(address) DO UPDATE SET balance=MAX(0, balance+excluded.balance)`),
    infect: db.prepare(`UPDATE wallets SET parent=?, gen=?, via=?, infected_at=?, infect_sig=?
                        WHERE address=? AND infected_at IS NULL`),
    burn: db.prepare('UPDATE wallets SET burned=burned+? WHERE address=?'),
    vax: db.prepare('UPDATE wallets SET vaccinated_at=? WHERE address=? AND vaccinated_at IS NULL'),
    ev: db.prepare('INSERT INTO events(sig,slot,t,kind,a,b,amount) VALUES(?,?,?,?,?,?,?)'),
  };

  const apply = db.transaction((p) => {
    if (!p || !p.sig || q.seen.get(p.sig)) return { skipped: true, changes: 0 };
    q.mark.run(p.sig, p.slot, p.t);
    if (p.err || !p.deltas.length) return { changes: 0 };

    const t = p.t ?? Math.floor(Date.now() / 1000);
    let changes = 0;

    for (const d of p.deltas) if (!pool.has(d.owner)) q.bal.run(d.owner, d.delta);

    const senders = p.deltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta);
    const receivers = p.deltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta);
    const src = senders[0]?.owner;
    const net = p.deltas.reduce((s, d) => s + d.delta, 0);

    // Burn / vaccine
    if (net < -1e-6 && src && !pool.has(src)) {
      const amt = -net;
      q.burn.run(amt, src);
      q.ev.run(p.sig, p.slot, t, 'burn', src, null, amt);
      changes++;
      const w = q.get.get(src);
      if (w && w.infected_at != null && w.vaccinated_at == null && src !== cfg.devWallet && w.burned >= cfg.vaxBurn) {
        q.vax.run(t, src);
        q.ev.run(p.sig, p.slot, t, 'vax', src, null, w.burned);
      }
    }

    // Infection
    if (src && receivers.length) {
      let parent = null, via = null, gen = 0;
      if (pool.has(src)) {
        parent = 'pool'; via = 'buy'; gen = 2;
      } else {
        const s = q.get.get(src);
        if (s && s.infected_at != null && (s.vaccinated_at == null || s.vaccinated_at > t)) {
          parent = src; via = 'transfer'; gen = (s.gen ?? 0) + 1;
        }
      }
      if (parent) {
        for (const r of receivers) {
          if (pool.has(r.owner) || r.owner === src || r.owner === cfg.devWallet || r.delta < cfg.minInfect) continue;
          const res = q.infect.run(parent, gen, via, t, p.sig, r.owner);
          if (res.changes) {
            q.ev.run(p.sig, p.slot, t, via, parent, r.owner, r.delta);
            changes++;
          }
        }
      }
    }
    return { changes };
  });

  return apply;
}
